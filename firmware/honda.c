#include "hardware/clocks.h"
#include "hardware/pio.h"
#include "hardware/watchdog.h"
#include "pico/stdlib.h"
#include "stepper.pio.h"
#include "w5500_ethernet.h"

#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define STEP1_PIN 4
#define DIR1_PIN  5
#define STEP2_PIN 6
#define DIR2_PIN  7
#define LED1_PIN  14
#define LED2_PIN  15

#define MOTOR1_ID 0x100u
#define MOTOR2_ID 0x101u

#ifndef MAX_SPEED_STEPS_PER_SEC
#define MAX_SPEED_STEPS_PER_SEC 20000u
#endif
#define DIR_SETUP_US 10u
#define RX_LINE_SIZE 64u
#define STEPPER_PIO_CLOCK_HZ 1000000u
#define STEPPER_PIO_FIXED_CYCLES 5u
#define MAIN_LOOP_WATCHDOG_MS 2000u

#ifndef MOTOR_API_WATCHDOG_MS
#define MOTOR_API_WATCHDOG_MS 1000u
#endif

typedef struct {
    uint step_pin;
    uint dir_pin;
    uint led_pin;
    PIO pio;
    uint state_machine;
    int32_t signed_speed;
    uint32_t speed_steps_per_sec;
    uint64_t stop_deadline_us;
} stepper_t;

static stepper_t motors[] = {
    {.step_pin = STEP1_PIN, .dir_pin = DIR1_PIN, .led_pin = LED1_PIN,
     .pio = pio0, .state_machine = 0},
    {.step_pin = STEP2_PIN, .dir_pin = DIR2_PIN, .led_pin = LED2_PIN,
     .pio = pio0, .state_machine = 1},
};
static uint stepper_program_offset;

static void stop_step_output(stepper_t *motor)
{
    pio_sm_set_enabled(motor->pio, motor->state_machine, false);
    pio_sm_clear_fifos(motor->pio, motor->state_machine);
    pio_sm_restart(motor->pio, motor->state_machine);
    pio_sm_exec(motor->pio, motor->state_machine,
                pio_encode_jmp(stepper_program_offset));
    pio_sm_set_pins_with_mask(motor->pio, motor->state_machine, 0,
                              1u << motor->step_pin);
}

static bool queue_step_output(stepper_t *motor, uint32_t steps_per_second)
{
    uint32_t period_cycles = STEPPER_PIO_CLOCK_HZ / steps_per_second;
    uint32_t delay_cycles =
        period_cycles > STEPPER_PIO_FIXED_CYCLES
            ? period_cycles - STEPPER_PIO_FIXED_CYCLES
            : 0;

    // The FIFO has just been cleared by stop_step_output(). Never let a
    // corrupted/unexpected PIO state block the network service loop forever.
    if (pio_sm_is_tx_fifo_full(motor->pio, motor->state_machine)) {
        return false;
    }
    pio_sm_put(motor->pio, motor->state_machine, delay_cycles);
    return true;
}

static bool start_step_output(stepper_t *motor, uint32_t steps_per_second)
{
    stop_step_output(motor);
    if (!queue_step_output(motor, steps_per_second)) {
        return false;
    }
    pio_sm_set_enabled(motor->pio, motor->state_machine, true);
    return true;
}

static uint32_t normalize_speed(int32_t *signed_speed)
{
    int64_t speed64 = *signed_speed;
    bool direction = speed64 >= 0;
    uint64_t magnitude = direction ? (uint64_t)speed64 : (uint64_t)(-speed64);
    if (magnitude > MAX_SPEED_STEPS_PER_SEC) {
        magnitude = MAX_SPEED_STEPS_PER_SEC;
        *signed_speed =
            direction ? (int32_t)magnitude : -(int32_t)magnitude;
    }
    return (uint32_t)magnitude;
}

static bool set_motor_pair_speed(int32_t motor1_speed, int32_t motor2_speed,
                                 uint32_t timeout_ms)
{
    int32_t requested[] = {motor1_speed, motor2_speed};
    uint64_t now = time_us_64();
    uint32_t enable_mask = 0;
    bool prepared = true;

    for (size_t index = 0; index < count_of(motors); ++index) {
        stepper_t *motor = &motors[index];
        int32_t signed_speed = requested[index];
        uint32_t magnitude = normalize_speed(&signed_speed);

        if (magnitude == 0) {
            if (motor->speed_steps_per_sec != 0) {
                stop_step_output(motor);
                gpio_put(motor->led_pin, 0);
            }
            motor->signed_speed = 0;
            motor->speed_steps_per_sec = 0;
            motor->stop_deadline_us = 0;
            continue;
        }

        if (motor->speed_steps_per_sec != 0 &&
            motor->signed_speed == signed_speed) {
            motor->stop_deadline_us =
                timeout_ms == 0
                    ? 0
                    : now + (uint64_t)timeout_ms * 1000u;
            continue;
        }

        stop_step_output(motor);
        gpio_put(motor->dir_pin, signed_speed >= 0);
        gpio_put(motor->led_pin, 1);
        motor->signed_speed = signed_speed;
        motor->speed_steps_per_sec = magnitude;
        motor->stop_deadline_us =
            timeout_ms == 0 ? 0 : now + (uint64_t)timeout_ms * 1000u;
        if (!queue_step_output(motor, magnitude)) {
            prepared = false;
            break;
        }
        enable_mask |= 1u << motor->state_machine;
    }

    if (!prepared) {
        // A synchronized command must never leave only one motor running.
        for (size_t index = 0; index < count_of(motors); ++index) {
            stop_step_output(&motors[index]);
            gpio_put(motors[index].led_pin, 0);
            motors[index].signed_speed = 0;
            motors[index].speed_steps_per_sec = 0;
            motors[index].stop_deadline_us = 0;
        }
        printf("PIO FIFO error: all motors stopped\r\n");
        return false;
    }
    if (enable_mask != 0) {
        sleep_us(DIR_SETUP_US);
        // Both PIO state machines in the mask are enabled by one register
        // write, so their first STEP edge starts on the same Pico clock.
        pio_set_sm_mask_enabled(pio0, enable_mask, true);
    }
    return true;
}

static bool set_motor_speed(stepper_t *motor, int32_t signed_speed,
                            uint32_t timeout_ms)
{
    bool direction = signed_speed >= 0;
    uint32_t magnitude = normalize_speed(&signed_speed);

    if (magnitude == 0) {
        if (motor->speed_steps_per_sec != 0) {
            stop_step_output(motor);
            gpio_put(motor->led_pin, 0);
        }
        motor->signed_speed = 0;
        motor->speed_steps_per_sec = 0;
        motor->stop_deadline_us = 0;
        return true;
    }

    uint64_t now = time_us_64();
    if (motor->speed_steps_per_sec != 0 &&
        motor->signed_speed == signed_speed) {
        // 同じ速度の再送はパルスを途切れさせず、安全停止期限だけ更新する。
        motor->stop_deadline_us =
            timeout_ms == 0 ? 0 : now + (uint64_t)timeout_ms * 1000u;
        return true;
    }

    stop_step_output(motor);
    gpio_put(motor->dir_pin, direction);
    sleep_us(DIR_SETUP_US);
    gpio_put(motor->led_pin, 1);
    motor->signed_speed = signed_speed;
    motor->speed_steps_per_sec = (uint32_t)magnitude;
    motor->stop_deadline_us =
        timeout_ms == 0 ? 0 : now + (uint64_t)timeout_ms * 1000u;
    if (!start_step_output(motor, motor->speed_steps_per_sec)) {
        gpio_put(motor->led_pin, 0);
        motor->signed_speed = 0;
        motor->speed_steps_per_sec = 0;
        motor->stop_deadline_us = 0;
        printf("PIO FIFO error: motor stopped\r\n");
        return false;
    }
    return true;
}

static void service_motor(stepper_t *motor, uint64_t now_us)
{
    if (motor->stop_deadline_us != 0 && now_us >= motor->stop_deadline_us) {
        (void)set_motor_speed(motor, 0, 0);
        printf("SAFE STOP: API command timeout\r\n");
        return;
    }

}

static bool parse_command(char *line, uint32_t *id, int32_t *data)
{
    char *p = line;
    while (isspace((unsigned char)*p)) {
        ++p;
    }

    char *end;
    errno = 0;
    unsigned long parsed_id = strtoul(p, &end, 0);
    if (end == p || errno == ERANGE || parsed_id > UINT32_MAX) {
        return false;
    }

    p = end;
    while (isspace((unsigned char)*p)) {
        ++p;
    }
    if (*p++ != ',') {
        return false;
    }
    while (isspace((unsigned char)*p)) {
        ++p;
    }

    errno = 0;
    long parsed_data = strtol(p, &end, 0);
    if (end == p || errno == ERANGE ||
        parsed_data < INT32_MIN || parsed_data > INT32_MAX) {
        return false;
    }
    while (isspace((unsigned char)*end)) {
        ++end;
    }
    if (*end != '\0') {
        return false;
    }

    *id = (uint32_t)parsed_id;
    *data = (int32_t)parsed_data;
    return true;
}

static stepper_t *motor_for_id(uint32_t id)
{
    switch (id) {
        case MOTOR1_ID:
            return &motors[0];
        case MOTOR2_ID:
            return &motors[1];
        default:
            return NULL;
    }
}

static bool execute_motor_command(uint32_t id, int32_t data, uint32_t timeout_ms)
{
    stepper_t *motor = motor_for_id(id);
    if (motor == NULL) {
        return false;
    }
    return set_motor_speed(motor, data, timeout_ms);
}

static bool execute_api_command(uint32_t id, int32_t data)
{
    stepper_t *motor = motor_for_id(id);
    bool changed = motor != NULL && motor->signed_speed != data;
    bool accepted = execute_motor_command(id, data, MOTOR_API_WATCHDOG_MS);
    if (accepted && changed) {
        printf("API OK 0x%lx,%ld\r\n", (unsigned long)id, (long)data);
    }
    return accepted;
}

static bool execute_api_pair_command(int32_t motor1_speed,
                                     int32_t motor2_speed)
{
    bool changed =
        motors[0].signed_speed != motor1_speed ||
        motors[1].signed_speed != motor2_speed;
    bool accepted =
        set_motor_pair_speed(motor1_speed, motor2_speed, MOTOR_API_WATCHDOG_MS);
    if (accepted && changed) {
        printf("API SYNC OK %ld,%ld\r\n",
               (long)motor1_speed, (long)motor2_speed);
    }
    return accepted;
}

static int32_t read_api_motor_speed(uint32_t id)
{
    stepper_t *motor = motor_for_id(id);
    return motor == NULL ? 0 : motor->signed_speed;
}

static void execute_usb_command(char *line)
{
    uint32_t id;
    int32_t data;

    if (!parse_command(line, &id, &data)) {
        printf("ERR format: use id,data (example: 0x100,800)\r\n");
        return;
    }
    if (!execute_motor_command(id, data, 0)) {
        printf("ERR unknown id: 0x%lx\r\n", (unsigned long)id);
        return;
    }
    printf("OK 0x%lx,%ld\r\n", (unsigned long)id, (long)data);
}

static void service_usb_input(void)
{
    static char line[RX_LINE_SIZE];
    static size_t length = 0;
    int ch;

    while ((ch = getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
        if (ch == '\r' || ch == '\n') {
            if (length != 0) {
                line[length] = '\0';
                execute_usb_command(line);
                length = 0;
            }
        } else if (length < RX_LINE_SIZE - 1) {
            line[length++] = (char)ch;
        } else {
            length = 0;
        }
    }
}

int main(void)
{
    stdio_init_all();

    stepper_program_offset = pio_add_program(pio0, &stepper_program);
    for (size_t i = 0; i < count_of(motors); ++i) {
        pio_sm_claim(motors[i].pio, motors[i].state_machine);
        pio_gpio_init(motors[i].pio, motors[i].step_pin);
        pio_sm_set_consecutive_pindirs(
            motors[i].pio, motors[i].state_machine,
            motors[i].step_pin, 1, true);
        pio_sm_config config =
            stepper_program_get_default_config(stepper_program_offset);
        sm_config_set_set_pins(&config, motors[i].step_pin, 1);
        sm_config_set_clkdiv(
            &config,
            (float)clock_get_hz(clk_sys) / (float)STEPPER_PIO_CLOCK_HZ);
        pio_sm_init(motors[i].pio, motors[i].state_machine,
                    stepper_program_offset, &config);
        stop_step_output(&motors[i]);

        gpio_init(motors[i].dir_pin);
        gpio_set_dir(motors[i].dir_pin, GPIO_OUT);
        gpio_put(motors[i].dir_pin, 0);

        gpio_init(motors[i].led_pin);
        gpio_set_dir(motors[i].led_pin, GPIO_OUT);
        gpio_put(motors[i].led_pin, 0);
    }

    // Last-resort containment for third-party network-library calls: any
    // unexpected main-loop stall resets the Pico and de-energizes STEP output
    // instead of leaving the controller permanently unreachable.
    watchdog_enable(MAIN_LOOP_WATCHDOG_MS, true);
    watchdog_update();

    bool ethernet_ready =
        w5500_ethernet_init(execute_api_command, execute_api_pair_command,
                            read_api_motor_speed);
    if (ethernet_ready) {
        printf("Open motor control page: http://%s/ "
               "(http://" MOTOR_HOSTNAME ".local/)\r\n",
               w5500_ethernet_ip_address());
    } else {
        printf("W5500 init failed; USB control remains available\r\n");
    }
    while (true) {
        watchdog_update();
        service_usb_input();

        uint64_t now_us = time_us_64();
        for (size_t i = 0; i < count_of(motors); ++i) {
            service_motor(&motors[i], now_us);
        }

        if (ethernet_ready) {
            w5500_ethernet_service();
        }
        watchdog_update();

        now_us = time_us_64();
        for (size_t i = 0; i < count_of(motors); ++i) {
            service_motor(&motors[i], now_us);
        }

        tight_loop_contents();
    }
}

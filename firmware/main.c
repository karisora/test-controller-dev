#include "pico/stdlib.h"
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

#define MAX_SPEED_STEPS_PER_SEC 20000u
#define STEP_HIGH_US 2u
#define DIR_SETUP_US 10u
#define RX_LINE_SIZE 64u

#ifndef MOTOR_API_WATCHDOG_MS
#define MOTOR_API_WATCHDOG_MS 10000u
#endif

typedef struct {
    uint step_pin;
    uint dir_pin;
    uint led_pin;
    int32_t signed_speed;
    uint32_t speed_steps_per_sec;
    uint64_t step_interval_us;
    uint64_t next_rise_us;
    uint64_t fall_us;
    uint64_t stop_deadline_us;
    bool step_is_high;
} stepper_t;

static stepper_t motors[] = {
    {.step_pin = STEP1_PIN, .dir_pin = DIR1_PIN, .led_pin = LED1_PIN},
    {.step_pin = STEP2_PIN, .dir_pin = DIR2_PIN, .led_pin = LED2_PIN},
};

static void set_motor_speed(stepper_t *motor, int32_t signed_speed,
                            uint32_t timeout_ms)
{
    int64_t speed64 = signed_speed;
    bool direction = speed64 >= 0;
    uint64_t magnitude = direction ? (uint64_t)speed64 : (uint64_t)(-speed64);

    if (magnitude == 0) {
        if (motor->speed_steps_per_sec != 0 || motor->step_is_high) {
            gpio_put(motor->step_pin, 0);
            gpio_put(motor->led_pin, 0);
        }
        motor->step_is_high = false;
        motor->signed_speed = 0;
        motor->speed_steps_per_sec = 0;
        motor->stop_deadline_us = 0;
        return;
    }

    if (magnitude > MAX_SPEED_STEPS_PER_SEC) {
        magnitude = MAX_SPEED_STEPS_PER_SEC;
        signed_speed = direction ? (int32_t)magnitude : -(int32_t)magnitude;
    }

    gpio_put(motor->step_pin, 0);
    motor->step_is_high = false;

    uint64_t now = time_us_64();
    gpio_put(motor->dir_pin, direction);
    gpio_put(motor->led_pin, 1);
    motor->signed_speed = signed_speed;
    motor->speed_steps_per_sec = (uint32_t)magnitude;
    motor->step_interval_us = 1000000u / magnitude;
    motor->next_rise_us = now + DIR_SETUP_US;
    motor->stop_deadline_us =
        timeout_ms == 0 ? 0 : now + (uint64_t)timeout_ms * 1000u;
}

static void service_motor(stepper_t *motor, uint64_t now_us)
{
    if (motor->stop_deadline_us != 0 && now_us >= motor->stop_deadline_us) {
        set_motor_speed(motor, 0, 0);
        printf("SAFE STOP: API command timeout\r\n");
        return;
    }

    if (motor->step_is_high && now_us >= motor->fall_us) {
        gpio_put(motor->step_pin, 0);
        motor->step_is_high = false;
    }

    if (motor->speed_steps_per_sec == 0 || motor->step_is_high ||
        now_us < motor->next_rise_us) {
        return;
    }

    gpio_put(motor->step_pin, 1);
    motor->step_is_high = true;
    motor->fall_us = now_us + STEP_HIGH_US;
    motor->next_rise_us = now_us + motor->step_interval_us;
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
    set_motor_speed(motor, data, timeout_ms);
    return true;
}

static bool execute_api_command(uint32_t id, int32_t data)
{
    bool accepted = execute_motor_command(id, data, MOTOR_API_WATCHDOG_MS);
    if (accepted) {
        printf("API OK 0x%lx,%ld\r\n", (unsigned long)id, (long)data);
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

    for (size_t i = 0; i < count_of(motors); ++i) {
        gpio_init(motors[i].step_pin);
        gpio_set_dir(motors[i].step_pin, GPIO_OUT);
        gpio_put(motors[i].step_pin, 0);

        gpio_init(motors[i].dir_pin);
        gpio_set_dir(motors[i].dir_pin, GPIO_OUT);
        gpio_put(motors[i].dir_pin, 0);

        gpio_init(motors[i].led_pin);
        gpio_set_dir(motors[i].led_pin, GPIO_OUT);
        gpio_put(motors[i].led_pin, 0);
    }

    bool ethernet_ready =
        w5500_ethernet_init(execute_api_command, read_api_motor_speed);
    printf(ethernet_ready
               ? "Motor API ready: http://" MOTOR_IP_ADDRESS "/api/status\r\n"
               : "W5500 init failed; USB control remains available\r\n");

    while (true) {
        service_usb_input();

        uint64_t now_us = time_us_64();
        for (size_t i = 0; i < count_of(motors); ++i) {
            service_motor(&motors[i], now_us);
        }

        if (ethernet_ready) {
            w5500_ethernet_service();
        }

        now_us = time_us_64();
        for (size_t i = 0; i < count_of(motors); ++i) {
            service_motor(&motors[i], now_us);
        }

        tight_loop_contents();
    }
}

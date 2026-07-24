#ifndef W5500_ETHERNET_H
#define W5500_ETHERNET_H

#include <stdbool.h>
#include <stdint.h>

#ifndef MOTOR_HOSTNAME
#define MOTOR_HOSTNAME "pico-motor"
#endif

typedef bool (*w5500_motor_command_callback_t)(uint32_t id, int32_t speed);
typedef bool (*w5500_motor_pair_command_callback_t)(int32_t motor1_speed,
                                                     int32_t motor2_speed);
typedef int32_t (*w5500_motor_status_callback_t)(uint32_t id);

bool w5500_ethernet_init(w5500_motor_command_callback_t command_callback,
                         w5500_motor_pair_command_callback_t pair_callback,
                         w5500_motor_status_callback_t status_callback);
void w5500_ethernet_service(void);
const char *w5500_ethernet_ip_address(void);

#endif

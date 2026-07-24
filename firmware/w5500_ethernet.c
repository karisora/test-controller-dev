#include "w5500_ethernet.h"

#include "dhcp.h"
#include "hardware/spi.h"
#include "mdns_responder.h"
#include "pico/stdlib.h"
#include "pico/time.h"
#include "socket.h"
#include "wizchip_conf.h"
#include "W5500/w5500.h"

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef W5500_SPI_PORT
#define W5500_SPI_PORT spi0
#endif
#ifndef W5500_SPI_BAUDRATE
#define W5500_SPI_BAUDRATE 20000000u
#endif
#ifndef W5500_MISO_PIN
#define W5500_MISO_PIN 16u
#endif
#ifndef W5500_CS_PIN
#define W5500_CS_PIN 17u
#endif
#ifndef W5500_SCK_PIN
#define W5500_SCK_PIN 18u
#endif
#ifndef W5500_MOSI_PIN
#define W5500_MOSI_PIN 19u
#endif
#ifndef W5500_RESET_PIN
#define W5500_RESET_PIN 20u
#endif

#ifndef MOTOR_MAC_OCTET_1
#define MOTOR_MAC_OCTET_1 0x02
#endif
#ifndef MOTOR_MAC_OCTET_2
#define MOTOR_MAC_OCTET_2 0x50
#endif
#ifndef MOTOR_MAC_OCTET_3
#define MOTOR_MAC_OCTET_3 0x49
#endif
#ifndef MOTOR_MAC_OCTET_4
#define MOTOR_MAC_OCTET_4 0x43
#endif
#ifndef MOTOR_MAC_OCTET_5
#define MOTOR_MAC_OCTET_5 0x4f
#endif
#ifndef MOTOR_MAC_OCTET_6
#define MOTOR_MAC_OCTET_6 0x01
#endif
#ifndef MOTOR_API_KEY
#define MOTOR_API_KEY ""
#endif
#ifndef MOTOR_API_WATCHDOG_MS
#define MOTOR_API_WATCHDOG_MS 10000u
#endif
#ifndef MAX_SPEED_STEPS_PER_SEC
#define MAX_SPEED_STEPS_PER_SEC 20000
#endif

#define HTTP_SOCKET 0
#define DHCP_SOCKET 1
#define HTTP_PORT 80
#define DHCP_BUFFER_SIZE 1024u
#define DHCP_STARTUP_TIMEOUT_US 15000000u
#define REQUEST_BUFFER_SIZE 1024u
#define RESPONSE_BUFFER_SIZE 768u
#define REQUEST_TIMEOUT_US 2000000u
#define MOTOR1_ID 0x100u
#define MOTOR2_ID 0x101u

static w5500_motor_command_callback_t command_motor;
static w5500_motor_status_callback_t read_motor_speed;
static char request_buffer[REQUEST_BUFFER_SIZE];
static size_t request_length;
static uint64_t request_started_us;
static uint8_t dhcp_buffer[DHCP_BUFFER_SIZE];
static wiz_NetInfo current_network;
static char current_ip_address[16] = "0.0.0.0";
static bool dhcp_enabled;
static bool dhcp_address_ready;
static bool mdns_started;
static bool dhcp_timer_started;
static struct repeating_timer dhcp_timer;

static void chip_select(void)
{
    gpio_put(W5500_CS_PIN, 0);
}

static void chip_deselect(void)
{
    gpio_put(W5500_CS_PIN, 1);
}

static uint8_t spi_read_byte(void)
{
    uint8_t value = 0;
    spi_read_blocking(W5500_SPI_PORT, 0xff, &value, 1);
    return value;
}

static void spi_write_byte(uint8_t value)
{
    spi_write_blocking(W5500_SPI_PORT, &value, 1);
}

static void reset_chip(void)
{
    gpio_put(W5500_RESET_PIN, 0);
    sleep_ms(2);
    gpio_put(W5500_RESET_PIN, 1);
    sleep_ms(100);
}

static void format_current_ip(void)
{
    snprintf(current_ip_address, sizeof(current_ip_address), "%u.%u.%u.%u",
             current_network.ip[0], current_network.ip[1],
             current_network.ip[2], current_network.ip[3]);
}

static void dhcp_address_callback(void)
{
    dhcp_address_ready = true;
}

static void dhcp_conflict_callback(void)
{
    dhcp_address_ready = false;
    printf("DHCP address conflict\r\n");
}

static bool apply_dhcp_address(void)
{
    wiz_NetInfo assigned = current_network;
    getSHAR(assigned.mac);
    getIPfromDHCP(assigned.ip);
    getGWfromDHCP(assigned.gw);
    getSNfromDHCP(assigned.sn);
    getDNSfromDHCP(assigned.dns);
    assigned.dhcp = NETINFO_DHCP;

    if ((assigned.ip[0] | assigned.ip[1] |
         assigned.ip[2] | assigned.ip[3]) == 0) {
        return false;
    }

    bool changed = memcmp(current_network.ip, assigned.ip, 4) != 0;
    current_network = assigned;
    ctlnetwork(CN_SET_NETINFO, &current_network);
    format_current_ip();
    dhcp_address_ready = false;
    return changed;
}

static void configure_link_local(void)
{
    wiz_NetInfo fallback = {
        .mac = {MOTOR_MAC_OCTET_1, MOTOR_MAC_OCTET_2, MOTOR_MAC_OCTET_3,
                MOTOR_MAC_OCTET_4, MOTOR_MAC_OCTET_5, MOTOR_MAC_OCTET_6},
        .ip = {169, 254, 50, 50},
        .sn = {255, 255, 0, 0},
        .gw = {0, 0, 0, 0},
        .dns = {0, 0, 0, 0},
        .dhcp = NETINFO_STATIC,
    };
    current_network = fallback;
    ctlnetwork(CN_SET_NETINFO, &current_network);
    format_current_ip();
    dhcp_enabled = false;
}

static bool dhcp_timer_callback(struct repeating_timer *timer)
{
    (void)timer;
    DHCP_time_handler();
    return true;
}

static bool acquire_network_address(void)
{
    memset(&current_network, 0, sizeof(current_network));
    current_network.mac[0] = MOTOR_MAC_OCTET_1;
    current_network.mac[1] = MOTOR_MAC_OCTET_2;
    current_network.mac[2] = MOTOR_MAC_OCTET_3;
    current_network.mac[3] = MOTOR_MAC_OCTET_4;
    current_network.mac[4] = MOTOR_MAC_OCTET_5;
    current_network.mac[5] = MOTOR_MAC_OCTET_6;
    current_network.dhcp = NETINFO_DHCP;
    setSHAR(current_network.mac);

    DHCP_init(DHCP_SOCKET, dhcp_buffer);
    reg_dhcp_cbfunc(dhcp_address_callback, dhcp_address_callback,
                    dhcp_conflict_callback);
    dhcp_enabled = true;
    dhcp_address_ready = false;
    dhcp_timer_started =
        add_repeating_timer_ms(1000, dhcp_timer_callback, NULL, &dhcp_timer);
    if (!dhcp_timer_started) {
        DHCP_stop();
        configure_link_local();
        printf("DHCP timer unavailable; using link-local %s\r\n",
               current_ip_address);
        return true;
    }
    uint64_t deadline = time_us_64() + DHCP_STARTUP_TIMEOUT_US;

    while (time_us_64() < deadline) {
        uint8_t result = DHCP_run();
        if (dhcp_address_ready || result == DHCP_IP_LEASED) {
            if (apply_dhcp_address()) {
                printf("DHCP assigned %s\r\n", current_ip_address);
                return true;
            }
        }
        sleep_ms(10);
    }

    DHCP_stop();
    if (dhcp_timer_started) {
        cancel_repeating_timer(&dhcp_timer);
        dhcp_timer_started = false;
    }
    configure_link_local();
    printf("DHCP unavailable; using link-local %s\r\n", current_ip_address);
    return true;
}

static bool ascii_equal_ignore_case(const char *left, const char *right,
                                    size_t length)
{
    for (size_t i = 0; i < length; ++i) {
        if (tolower((unsigned char)left[i]) !=
            tolower((unsigned char)right[i])) {
            return false;
        }
    }
    return true;
}

static const char *find_header(const char *request, const char *name)
{
    size_t name_length = strlen(name);
    const char *line = strstr(request, "\r\n");
    if (line == NULL) {
        return NULL;
    }
    line += 2;

    while (*line != '\0' && strncmp(line, "\r\n", 2) != 0) {
        const char *line_end = strstr(line, "\r\n");
        if (line_end == NULL) {
            return NULL;
        }
        size_t line_length = (size_t)(line_end - line);
        if (line_length > name_length && line[name_length] == ':' &&
            ascii_equal_ignore_case(line, name, name_length)) {
            const char *value = line + name_length + 1;
            while (value < line_end && isspace((unsigned char)*value)) {
                ++value;
            }
            return value;
        }
        line = line_end + 2;
    }
    return NULL;
}

static size_t header_value_length(const char *value)
{
    const char *end = strstr(value, "\r\n");
    if (end == NULL) {
        return 0;
    }
    while (end > value && isspace((unsigned char)end[-1])) {
        --end;
    }
    return (size_t)(end - value);
}

static bool authorized(const char *request)
{
    const char expected[] = MOTOR_API_KEY;
    if (sizeof(expected) == 1) {
        return true;
    }

    const char *value = find_header(request, "X-API-Key");
    return value != NULL &&
           header_value_length(value) == sizeof(expected) - 1 &&
           memcmp(value, expected, sizeof(expected) - 1) == 0;
}

static size_t request_content_length(const char *request)
{
    const char *value = find_header(request, "Content-Length");
    if (value == NULL) {
        return 0;
    }
    char *end;
    errno = 0;
    unsigned long length = strtoul(value, &end, 10);
    if (end == value || errno == ERANGE || length > REQUEST_BUFFER_SIZE) {
        return REQUEST_BUFFER_SIZE;
    }
    return (size_t)length;
}

static bool parse_speed_json(const char *body, int32_t *speed)
{
    const char *key = strstr(body, "\"speed\"");
    if (key == NULL) {
        return false;
    }
    const char *colon = strchr(key + 7, ':');
    if (colon == NULL) {
        return false;
    }

    char *end;
    errno = 0;
    const char *value = colon + 1;
    while (isspace((unsigned char)*value)) {
        ++value;
    }
    long parsed = strtol(value, &end, 10);
    if (end == value || errno == ERANGE || parsed < INT32_MIN ||
        parsed > INT32_MAX || parsed < -MAX_SPEED_STEPS_PER_SEC ||
        parsed > MAX_SPEED_STEPS_PER_SEC) {
        return false;
    }
    while (isspace((unsigned char)*end)) {
        ++end;
    }
    if (*end != '}' && *end != ',') {
        return false;
    }
    *speed = (int32_t)parsed;
    return true;
}

static void send_json(int status, const char *status_text, const char *json)
{
    char response[RESPONSE_BUFFER_SIZE];
    int body_length = (int)strlen(json);
    int length = snprintf(
        response, sizeof(response),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-store\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, X-API-Key\r\n"
        "Access-Control-Allow-Private-Network: true\r\n"
        "Connection: close\r\n\r\n%s",
        status, status_text, body_length, json);
    if (length > 0 && (size_t)length < sizeof(response)) {
        send(HTTP_SOCKET, (uint8_t *)response, (uint16_t)length);
    }
}

static void send_status(void)
{
    int32_t motor1 = read_motor_speed == NULL ? 0 : read_motor_speed(MOTOR1_ID);
    int32_t motor2 = read_motor_speed == NULL ? 0 : read_motor_speed(MOTOR2_ID);
    char body[400];
    snprintf(
        body, sizeof(body),
        "{\"ok\":true,\"ip\":\"%s\","
        "\"hostname\":\"" MOTOR_HOSTNAME ".local\","
        "\"networkMode\":\"%s\","
        "\"motors\":["
        "{\"id\":\"0x100\",\"speed\":%ld,\"running\":%s},"
        "{\"id\":\"0x101\",\"speed\":%ld,\"running\":%s}],"
        "\"maxSpeed\":%d,\"watchdogMs\":%u,\"apiKeyRequired\":%s}",
        current_ip_address, dhcp_enabled ? "dhcp" : "link-local",
        (long)motor1, motor1 == 0 ? "false" : "true",
        (long)motor2, motor2 == 0 ? "false" : "true",
        MAX_SPEED_STEPS_PER_SEC, MOTOR_API_WATCHDOG_MS,
        sizeof(MOTOR_API_KEY) > 1 ? "true" : "false");
    send_json(200, "OK", body);
}

static void handle_request(char *request)
{
    char method[8];
    char path[80];
    char version[16];
    if (sscanf(request, "%7s %79s %15s", method, path, version) != 3) {
        send_json(400, "Bad Request",
                  "{\"ok\":false,\"error\":\"invalid request\"}");
        return;
    }

    if (strcmp(method, "OPTIONS") == 0) {
        send_json(204, "No Content", "");
        return;
    }
    if (!authorized(request)) {
        send_json(401, "Unauthorized",
                  "{\"ok\":false,\"error\":\"invalid API key\"}");
        return;
    }
    if (strcmp(method, "GET") == 0 &&
        (strcmp(path, "/api/status") == 0 ||
         strcmp(path, "/api/health") == 0)) {
        send_status();
        return;
    }
    if (strcmp(method, "POST") == 0 && strcmp(path, "/api/stop") == 0) {
        bool first = command_motor != NULL && command_motor(MOTOR1_ID, 0);
        bool second = command_motor != NULL && command_motor(MOTOR2_ID, 0);
        if (first && second) {
            send_status();
        } else {
            send_json(500, "Internal Server Error",
                      "{\"ok\":false,\"error\":\"motor callback failed\"}");
        }
        return;
    }

    bool motor_method =
        strcmp(method, "PUT") == 0 || strcmp(method, "POST") == 0;
    uint32_t id = 0;
    if (strcmp(path, "/api/motors/1") == 0) {
        id = MOTOR1_ID;
    } else if (strcmp(path, "/api/motors/2") == 0) {
        id = MOTOR2_ID;
    }
    if (motor_method && id != 0) {
        char *body = strstr(request, "\r\n\r\n");
        int32_t speed;
        if (body == NULL || !parse_speed_json(body + 4, &speed)) {
            send_json(400, "Bad Request",
                      "{\"ok\":false,\"error\":\"speed must be an integer "
                      "between -20000 and 20000\"}");
            return;
        }
        if (command_motor == NULL || !command_motor(id, speed)) {
            send_json(500, "Internal Server Error",
                      "{\"ok\":false,\"error\":\"motor callback failed\"}");
            return;
        }
        send_status();
        return;
    }

    send_json(404, "Not Found",
              "{\"ok\":false,\"error\":\"endpoint not found\"}");
}

static void reset_request(void)
{
    request_length = 0;
    request_started_us = 0;
    request_buffer[0] = '\0';
}

static void service_dhcp(void)
{
    if (!dhcp_enabled) {
        return;
    }

    uint8_t result = DHCP_run();
    if (!dhcp_address_ready && result != DHCP_IP_ASSIGN &&
        result != DHCP_IP_CHANGED && result != DHCP_IP_LEASED) {
        return;
    }

    if (apply_dhcp_address()) {
        printf("DHCP address changed to %s\r\n", current_ip_address);
        close(HTTP_SOCKET);
        reset_request();
        if (mdns_started) {
            mdns_responder_stop();
            mdns_started = mdns_responder_init(MOTOR_HOSTNAME);
        }
    }
}

bool w5500_ethernet_init(w5500_motor_command_callback_t command_callback,
                         w5500_motor_status_callback_t status_callback)
{
    command_motor = command_callback;
    read_motor_speed = status_callback;
    reset_request();

    gpio_init(W5500_CS_PIN);
    gpio_set_dir(W5500_CS_PIN, GPIO_OUT);
    chip_deselect();
    gpio_init(W5500_RESET_PIN);
    gpio_set_dir(W5500_RESET_PIN, GPIO_OUT);
    gpio_put(W5500_RESET_PIN, 1);

    spi_init(W5500_SPI_PORT, W5500_SPI_BAUDRATE);
    gpio_set_function(W5500_MISO_PIN, GPIO_FUNC_SPI);
    gpio_set_function(W5500_SCK_PIN, GPIO_FUNC_SPI);
    gpio_set_function(W5500_MOSI_PIN, GPIO_FUNC_SPI);
    spi_set_format(W5500_SPI_PORT, 8, SPI_CPOL_0, SPI_CPHA_0,
                   SPI_MSB_FIRST);

    reset_chip();
    reg_wizchip_cs_cbfunc(chip_select, chip_deselect);
    reg_wizchip_spi_cbfunc(spi_read_byte, spi_write_byte);

    uint8_t tx_sizes[8] = {2, 2, 2, 2, 2, 2, 2, 2};
    uint8_t rx_sizes[8] = {2, 2, 2, 2, 2, 2, 2, 2};
    if (wizchip_init(tx_sizes, rx_sizes) != 0 || getVERSIONR() != 0x04) {
        return false;
    }

    acquire_network_address();
    mdns_started = mdns_responder_init(MOTOR_HOSTNAME);
    if (!mdns_started) {
        printf("mDNS init failed; use http://%s instead\r\n",
               current_ip_address);
    }
    return true;
}

void w5500_ethernet_service(void)
{
    service_dhcp();

    uint8_t state = getSn_SR(HTTP_SOCKET);

    switch (state) {
        case SOCK_CLOSED:
            reset_request();
            socket(HTTP_SOCKET, Sn_MR_TCP, HTTP_PORT, 0);
            break;
        case SOCK_INIT:
            listen(HTTP_SOCKET);
            break;
        case SOCK_ESTABLISHED: {
            if (getSn_IR(HTTP_SOCKET) & Sn_IR_CON) {
                setSn_IR(HTTP_SOCKET, Sn_IR_CON);
                reset_request();
            }

            uint16_t available = getSn_RX_RSR(HTTP_SOCKET);
            if (available != 0) {
                if (request_started_us == 0) {
                    request_started_us = time_us_64();
                }
                size_t space = REQUEST_BUFFER_SIZE - 1 - request_length;
                uint16_t chunk = available < space ? available : (uint16_t)space;
                if (chunk == 0) {
                    send_json(413, "Payload Too Large",
                              "{\"ok\":false,\"error\":\"request too large\"}");
                    disconnect(HTTP_SOCKET);
                    reset_request();
                    break;
                }
                int32_t received =
                    recv(HTTP_SOCKET,
                         (uint8_t *)request_buffer + request_length, chunk);
                if (received > 0) {
                    request_length += (size_t)received;
                    request_buffer[request_length] = '\0';
                }
            }

            char *header_end = strstr(request_buffer, "\r\n\r\n");
            if (header_end != NULL) {
                size_t header_length = (size_t)(header_end - request_buffer) + 4;
                size_t content_length = request_content_length(request_buffer);
                if (request_length >= header_length + content_length) {
                    handle_request(request_buffer);
                    disconnect(HTTP_SOCKET);
                    reset_request();
                }
            }
            if (request_started_us != 0 &&
                time_us_64() - request_started_us > REQUEST_TIMEOUT_US) {
                send_json(408, "Request Timeout",
                          "{\"ok\":false,\"error\":\"request timeout\"}");
                disconnect(HTTP_SOCKET);
                reset_request();
            }
            break;
        }
        case SOCK_CLOSE_WAIT:
            disconnect(HTTP_SOCKET);
            reset_request();
            break;
        default:
            break;
    }

    if (mdns_started) {
        mdns_responder_service(current_network.ip);
    }
}

const char *w5500_ethernet_ip_address(void)
{
    return current_ip_address;
}

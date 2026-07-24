#include "w5500_ethernet.h"

#include "dhcp.h"
#include "hardware/spi.h"
#include "mdns_responder.h"
#include "pico/stdlib.h"
#include "pico/time.h"
#include "pico/unique_id.h"
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
#define MOTOR_API_WATCHDOG_MS 1000u
#endif
#ifndef MOTOR_FIRMWARE_VERSION
#define MOTOR_FIRMWARE_VERSION "dev"
#endif
#ifndef MAX_SPEED_STEPS_PER_SEC
#define MAX_SPEED_STEPS_PER_SEC 20000
#endif

#define HTTP_SOCKET_FIRST 0u
#define HTTP_SOCKET_COUNT 4u
#define DHCP_SOCKET 4u
#define HTTP_PORT 80
#define DHCP_BUFFER_SIZE 1024u
#define DHCP_STARTUP_TIMEOUT_US 15000000u
#define REQUEST_BUFFER_SIZE 2048u
#define RESPONSE_BUFFER_SIZE 2048u
#define REQUEST_TIMEOUT_US 2000000u
#define RESPONSE_CLOSE_TIMEOUT_US 1000000u
#define HTTP_CLOSE_TIMEOUT_US 250000u
#define PHY_LINK_CHECK_INTERVAL_US 1000u
#define MOTOR1_ID 0x100u
#define MOTOR2_ID 0x101u

static w5500_motor_command_callback_t command_motor;
static w5500_motor_status_callback_t read_motor_speed;

typedef struct {
    char request_buffer[REQUEST_BUFFER_SIZE];
    size_t request_length;
    uint64_t request_started_us;
    bool response_sent;
    uint64_t response_sent_us;
    bool response_queued;
    uint8_t previous_state;
    uint64_t state_started_us;
} http_connection_t;

static http_connection_t http_connections[HTTP_SOCKET_COUNT];
static uint8_t active_http_socket;
static http_connection_t *active_http_connection;
static uint8_t dhcp_buffer[DHCP_BUFFER_SIZE];
static wiz_NetInfo current_network;
static uint8_t device_mac[6] = {
    MOTOR_MAC_OCTET_1, MOTOR_MAC_OCTET_2, MOTOR_MAC_OCTET_3,
    MOTOR_MAC_OCTET_4, MOTOR_MAC_OCTET_5, MOTOR_MAC_OCTET_6,
};
static char current_ip_address[16] = "0.0.0.0";
static bool dhcp_enabled;
static bool dhcp_address_ready;
static bool mdns_started;
static bool dhcp_timer_started;
static struct repeating_timer dhcp_timer;
static bool phy_link_up;
static bool phy_link_initialized;
static uint64_t next_phy_link_check_us;

static bool service_phy_link(void);

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

static void configure_unique_mac(void)
{
    pico_unique_board_id_t board_id;
    pico_get_unique_board_id(&board_id);

    // ローカル管理・ユニキャストMAC。複数台を同じLANへ接続しても衝突しない
    // よう、Pico固有IDの全バイトを末尾5バイトへ畳み込む。
    device_mac[0] = 0x02;
    device_mac[1] = 0x50;
    device_mac[2] = 0x49;
    device_mac[3] = 0x43;
    device_mac[4] = 0x4f;
    device_mac[5] = 0;
    for (size_t i = 0; i < PICO_UNIQUE_BOARD_ID_SIZE_BYTES; ++i) {
        device_mac[1 + i % 5] ^= board_id.id[i];
    }
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
        .ip = {169, 254, 50, 50},
        .sn = {255, 255, 0, 0},
        .gw = {0, 0, 0, 0},
        .dns = {0, 0, 0, 0},
        .dhcp = NETINFO_STATIC,
    };
    memcpy(fallback.mac, device_mac, sizeof(fallback.mac));
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

static void stop_dhcp_client(void)
{
    if (dhcp_enabled) {
        DHCP_stop();
        dhcp_enabled = false;
    }
    if (dhcp_timer_started) {
        cancel_repeating_timer(&dhcp_timer);
        dhcp_timer_started = false;
    }
    dhcp_address_ready = false;
}

static bool acquire_network_address(void)
{
    stop_dhcp_client();
    memset(&current_network, 0, sizeof(current_network));
    memcpy(current_network.mac, device_mac, sizeof(current_network.mac));
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
        uint8_t link_status = PHY_LINK_OFF;
        if (ctlwizchip(CW_GET_PHYLINK, &link_status) == 0 &&
            link_status != PHY_LINK_ON) {
            break;
        }
        uint8_t result = DHCP_run();
        if (dhcp_address_ready || result == DHCP_IP_LEASED) {
            if (apply_dhcp_address()) {
                printf("DHCP assigned %s\r\n", current_ip_address);
                return true;
            }
        }
        sleep_ms(10);
    }

    stop_dhcp_client();
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

static bool queue_http_response(const uint8_t *first, size_t first_length,
                                const uint8_t *second, size_t second_length)
{
    size_t total = first_length + second_length;
    if (active_http_connection == NULL || total == 0 ||
        total > getSn_TxMAX(active_http_socket) ||
        total > getSn_TX_FSR(active_http_socket)) {
        return false;
    }

    wiz_send_data(active_http_socket, (uint8_t *)first,
                  (uint16_t)first_length);
    if (second != NULL && second_length != 0) {
        wiz_send_data(active_http_socket, (uint8_t *)second,
                      (uint16_t)second_length);
    }
    setSn_CR(active_http_socket, Sn_CR_SEND);
    while (getSn_CR(active_http_socket) != 0) {
    }
    active_http_connection->response_queued = true;
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
        "Access-Control-Allow-Headers: Content-Type, X-API-Key, Accept\r\n"
        "Access-Control-Allow-Private-Network: true\r\n"
        "Access-Control-Max-Age: 600\r\n"
        "Connection: close\r\n\r\n%s",
        status, status_text, body_length, json);
    if (length > 0 && (size_t)length < sizeof(response)) {
        queue_http_response((const uint8_t *)response, (size_t)length,
                            NULL, 0);
    }
}

static void send_control_page(void)
{
    static const char page[] =
        "<!doctype html><html lang=\"ja\"><head>"
        "<meta charset=\"utf-8\"><meta name=\"viewport\" "
        "content=\"width=device-width,initial-scale=1\">"
        "<title>Pico Motor</title><style>"
        "body{font:16px sans-serif;max-width:560px;margin:30px auto;padding:16px}"
        ".motor{padding:16px;margin:12px 0;border:1px solid #bbb;border-radius:8px}"
        "input{width:130px;padding:8px}button{padding:9px;margin:4px}"
        "pre{white-space:pre-wrap;background:#eee;padding:12px}</style></head>"
        "<body><h1>W5500 Motor API</h1>"
        "<div class=\"motor\">Motor 1 <input id=\"s1\" type=\"number\" "
        "min=\"-20000\" max=\"20000\" value=\"800\">"
        "<button onclick=\"run(1)\">送信</button>"
        "<button onclick=\"halt(1)\">停止</button></div>"
        "<div class=\"motor\">Motor 2 <input id=\"s2\" type=\"number\" "
        "min=\"-20000\" max=\"20000\" value=\"800\">"
        "<button onclick=\"run(2)\">送信</button>"
        "<button onclick=\"halt(2)\">停止</button></div>"
        "<button onclick=\"stopAll()\">すべて停止</button>"
        "<button onclick=\"status()\">状態更新</button><pre id=\"out\">接続中...</pre>"
        "<script>"
        "const out=document.getElementById('out'),timers={};let pending=Promise.resolve();"
        "async function request(url,opt){try{let r=await fetch(url,opt);"
        "let t=await r.text();out.textContent='HTTP '+r.status+'\\n'+t;"
        "if(!r.ok)throw Error(t);return t}catch(e){out.textContent='接続エラー: '+e;"
        "throw e}}"
        "function call(url,opt){pending=pending.catch(()=>{}).then(()=>request(url,opt));"
        "return pending}"
        "function setMotor(n,v){return call('/api/motors/'+n,{method:'PUT',"
        "headers:{'Content-Type':'application/json'},body:JSON.stringify({speed:v})})}"
        "function run(n){let send=()=>setMotor(n,Number(document.getElementById('s'+n).value));"
        "clearInterval(timers[n]);send();timers[n]=setInterval(send,500)}"
        "function halt(n){clearInterval(timers[n]);setMotor(n,0)}"
        "function stopAll(){clearInterval(timers[1]);clearInterval(timers[2]);"
        "call('/api/stop',{method:'POST'})}"
        "function status(){call('/api/status')}"
        "status();</script></body></html>";

    int body_length = (int)strlen(page);
    char header[192];
    int header_length = snprintf(
        header, sizeof(header),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n",
        body_length);
    if (header_length > 0 && (size_t)header_length < sizeof(header)) {
        queue_http_response((const uint8_t *)header, (size_t)header_length,
                            (const uint8_t *)page, (size_t)body_length);
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
        "\"firmwareVersion\":\"" MOTOR_FIRMWARE_VERSION "\","
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
    char *query = strchr(path, '?');
    if (query != NULL) {
        *query = '\0';
    }

    if (strcmp(method, "OPTIONS") == 0) {
        send_json(204, "No Content", "");
        return;
    }
    if (strcmp(method, "GET") == 0 &&
        (strcmp(path, "/") == 0 || strcmp(path, "/index.html") == 0)) {
        send_control_page();
        return;
    }
    if (!authorized(request)) {
        send_json(401, "Unauthorized",
                  "{\"ok\":false,\"error\":\"invalid API key\"}");
        return;
    }
    if (strcmp(method, "GET") == 0 &&
        (strcmp(path, "/api/status") == 0 ||
         strcmp(path, "/api/health") == 0 ||
         strcmp(path, "/api") == 0)) {
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

static void reset_request(http_connection_t *connection)
{
    connection->request_length = 0;
    connection->request_started_us = 0;
    connection->response_sent = false;
    connection->response_sent_us = 0;
    connection->response_queued = false;
    connection->request_buffer[0] = '\0';
}

static void mark_response_sent(http_connection_t *connection)
{
    connection->request_length = 0;
    connection->request_started_us = 0;
    connection->request_buffer[0] = '\0';
    connection->response_sent = true;
    connection->response_sent_us = time_us_64();
}

static void reset_http_socket(uint8_t socket_number,
                              http_connection_t *connection)
{
    // ioLibrary close() waits until Sn_SR becomes CLOSED and can block the
    // whole Pico for seconds if a browser disappears mid-handshake. W5500's
    // CLOSE command is immediate, so issue it directly and continue polling.
    setSn_CR(socket_number, Sn_CR_CLOSE);
    while (getSn_CR(socket_number) != 0) {
    }
    setSn_IR(socket_number, 0xff);
    reset_request(connection);
    connection->previous_state = 0xffu;
    connection->state_started_us = time_us_64();
}

static bool open_http_socket(uint8_t socket_number)
{
    setSn_MR(socket_number, Sn_MR_TCP);
    setSn_PORT(socket_number, HTTP_PORT);
    setSn_CR(socket_number, Sn_CR_OPEN);
    while (getSn_CR(socket_number) != 0) {
    }
    return getSn_SR(socket_number) == SOCK_INIT;
}

static bool listen_http_socket(uint8_t socket_number)
{
    setSn_CR(socket_number, Sn_CR_LISTEN);
    while (getSn_CR(socket_number) != 0) {
    }
    return getSn_SR(socket_number) == SOCK_LISTEN;
}

static void begin_passive_http_disconnect(
    uint8_t socket_number, http_connection_t *connection)
{
    // CLOSE_WAIT means the browser has already sent FIN. Reply with FIN
    // without calling ioLibrary disconnect(), which waits synchronously.
    setSn_CR(socket_number, Sn_CR_DISCON);
    while (getSn_CR(socket_number) != 0) {
    }
    reset_request(connection);
    connection->previous_state = 0xffu;
    connection->state_started_us = time_us_64();
}

static void reset_all_http_sockets(void)
{
    for (uint8_t index = 0; index < HTTP_SOCKET_COUNT; ++index) {
        reset_http_socket(HTTP_SOCKET_FIRST + index,
                          &http_connections[index]);
    }
}

static bool service_phy_link(void)
{
    uint64_t now = time_us_64();
    if (phy_link_initialized && now < next_phy_link_check_us) {
        return phy_link_up;
    }
    next_phy_link_check_us = now + PHY_LINK_CHECK_INTERVAL_US;

    uint8_t link_status = PHY_LINK_OFF;
    if (ctlwizchip(CW_GET_PHYLINK, &link_status) != 0) {
        return phy_link_up;
    }

    bool link_is_up = link_status == PHY_LINK_ON;
    if (!phy_link_initialized) {
        phy_link_initialized = true;
        phy_link_up = link_is_up;
        return phy_link_up;
    }
    if (link_is_up == phy_link_up) {
        return phy_link_up;
    }

    phy_link_up = link_is_up;
    if (!phy_link_up) {
        // PHYリンク断を検出した時点で、API制御中かどうかに関係なく停止する。
        if (command_motor != NULL) {
            command_motor(MOTOR1_ID, 0);
            command_motor(MOTOR2_ID, 0);
        }
        reset_all_http_sockets();
        stop_dhcp_client();
        if (mdns_started) {
            mdns_responder_stop();
            mdns_started = false;
        }
        printf("LAN link lost: all motors stopped\r\n");
        return false;
    }

    printf("LAN link restored\r\n");
    reset_all_http_sockets();
    acquire_network_address();
    if (!mdns_started) {
        mdns_started = mdns_responder_init(MOTOR_HOSTNAME);
    }
    printf("Motor API: http://%s/ (http://" MOTOR_HOSTNAME ".local/)\r\n",
           current_ip_address);
    return true;
}

static void service_dhcp(void)
{
    if (!dhcp_enabled) {
        return;
    }

    DHCP_run();
    if (!dhcp_address_ready) {
        return;
    }

    if (apply_dhcp_address()) {
        printf("DHCP address changed to %s\r\n", current_ip_address);
        reset_all_http_sockets();
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
    active_http_connection = NULL;
    for (uint8_t index = 0; index < HTTP_SOCKET_COUNT; ++index) {
        reset_request(&http_connections[index]);
        http_connections[index].previous_state = 0xffu;
        http_connections[index].state_started_us = 0;
    }
    configure_unique_mac();

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
        printf("W5500 communication failed\r\n");
        return false;
    }

    phy_link_up = false;
    phy_link_initialized = false;
    next_phy_link_check_us = 0;
    service_phy_link();
    if (phy_link_up) {
        acquire_network_address();
    } else {
        configure_link_local();
        printf("LAN cable is not connected; DHCP will start when link is up\r\n");
    }

    printf("W5500 MAC %02x:%02x:%02x:%02x:%02x:%02x\r\n",
           device_mac[0], device_mac[1], device_mac[2],
           device_mac[3], device_mac[4], device_mac[5]);
    mdns_started = phy_link_up && mdns_responder_init(MOTOR_HOSTNAME);
    if (!mdns_started) {
        printf("mDNS is not active; use http://%s/ after LAN link is up\r\n",
               current_ip_address);
    }
    return true;
}

static void service_http_socket(uint8_t socket_number,
                                http_connection_t *connection)
{
    active_http_socket = socket_number;
    active_http_connection = connection;
    uint8_t state = getSn_SR(socket_number);
    uint64_t now = time_us_64();
    if (state != connection->previous_state) {
        connection->previous_state = state;
        connection->state_started_us = now;
    }

    switch (state) {
        case SOCK_CLOSED:
            reset_request(connection);
            if (!open_http_socket(socket_number)) {
                reset_http_socket(socket_number, connection);
            }
            break;
        case SOCK_INIT:
            if (!listen_http_socket(socket_number)) {
                reset_http_socket(socket_number, connection);
            }
            break;
        case SOCK_ESTABLISHED: {
            if (getSn_IR(socket_number) & Sn_IR_CON) {
                setSn_IR(socket_number, Sn_IR_CON);
                reset_request(connection);
            }

            if (connection->response_sent) {
                uint8_t interrupts = getSn_IR(socket_number);
                if (interrupts & Sn_IR_TIMEOUT) {
                    setSn_IR(socket_number, Sn_IR_TIMEOUT);
                    reset_http_socket(socket_number, connection);
                    break;
                }
                if (interrupts & Sn_IR_SENDOK) {
                    setSn_IR(socket_number, Sn_IR_SENDOK);
                }
                if (now - connection->response_sent_us >=
                    RESPONSE_CLOSE_TIMEOUT_US) {
                    reset_http_socket(socket_number, connection);
                }
                break;
            }

            uint16_t available = getSn_RX_RSR(socket_number);
            if (available != 0) {
                if (connection->request_started_us == 0) {
                    connection->request_started_us = time_us_64();
                }
                size_t space =
                    REQUEST_BUFFER_SIZE - 1 - connection->request_length;
                uint16_t chunk = available < space ? available : (uint16_t)space;
                if (chunk == 0) {
                    send_json(413, "Payload Too Large",
                              "{\"ok\":false,\"error\":\"request too large\"}");
                    if (connection->response_queued) {
                        mark_response_sent(connection);
                    } else {
                        reset_http_socket(socket_number, connection);
                    }
                    break;
                }
                int32_t received =
                    recv(socket_number,
                         (uint8_t *)connection->request_buffer +
                             connection->request_length,
                         chunk);
                if (received > 0) {
                    connection->request_length += (size_t)received;
                    connection->request_buffer[connection->request_length] =
                        '\0';
                }
            }

            char *header_end =
                strstr(connection->request_buffer, "\r\n\r\n");
            if (header_end != NULL) {
                size_t header_length =
                    (size_t)(header_end - connection->request_buffer) + 4;
                size_t content_length =
                    request_content_length(connection->request_buffer);
                if (connection->request_length >=
                    header_length + content_length) {
                    handle_request(connection->request_buffer);
                    if (connection->response_queued) {
                        mark_response_sent(connection);
                    } else {
                        reset_http_socket(socket_number, connection);
                    }
                }
            }
            if (connection->request_started_us != 0 &&
                time_us_64() - connection->request_started_us >
                    REQUEST_TIMEOUT_US) {
                send_json(408, "Request Timeout",
                          "{\"ok\":false,\"error\":\"request timeout\"}");
                if (connection->response_queued) {
                    mark_response_sent(connection);
                } else {
                    reset_http_socket(socket_number, connection);
                }
            }
            break;
        }
        case SOCK_CLOSE_WAIT:
            begin_passive_http_disconnect(socket_number, connection);
            break;
        case SOCK_FIN_WAIT:
        case SOCK_CLOSING:
        case SOCK_TIME_WAIT:
        case SOCK_LAST_ACK:
        case SOCK_SYNSENT:
        case SOCK_SYNRECV:
            // If the peer vanished during the TCP close handshake, W5500 can
            // otherwise remain in a transitional state and never listen again.
            if (now - connection->state_started_us >= HTTP_CLOSE_TIMEOUT_US) {
                reset_http_socket(socket_number, connection);
            }
            break;
        default:
            reset_http_socket(socket_number, connection);
            break;
    }
    active_http_connection = NULL;
}

void w5500_ethernet_service(void)
{
    if (!service_phy_link()) {
        return;
    }

    service_dhcp();

    for (uint8_t index = 0; index < HTTP_SOCKET_COUNT; ++index) {
        service_http_socket(HTTP_SOCKET_FIRST + index,
                            &http_connections[index]);
    }

    if (mdns_started) {
        mdns_responder_service(current_network.ip);
    }
}

const char *w5500_ethernet_ip_address(void)
{
    return current_ip_address;
}

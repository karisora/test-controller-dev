#include "mdns_responder.h"

#include "socket.h"
#include "W5500/w5500.h"
#include "pico/time.h"

#include <ctype.h>
#include <stddef.h>
#include <string.h>

#define MDNS_SOCKET 5
#define MDNS_PORT 5353u
#define MDNS_BUFFER_SIZE 512u
#define MDNS_TTL_SECONDS 120u
#define SOCKET_COMMAND_TIMEOUT_US 2000u

static uint8_t multicast_ip[4] = {224, 0, 0, 251};
static uint8_t multicast_mac[6] = {0x01, 0x00, 0x5e, 0x00, 0x00, 0xfb};
static uint8_t encoded_name[64];
static size_t encoded_name_length;

static bool issue_socket_command(uint8_t command)
{
    setSn_CR(MDNS_SOCKET, command);
    uint64_t deadline = time_us_64() + SOCKET_COMMAND_TIMEOUT_US;
    while (getSn_CR(MDNS_SOCKET) != 0) {
        if (time_us_64() >= deadline) {
            return false;
        }
    }
    return true;
}

static int32_t receive_packet(uint8_t *destination, uint16_t capacity,
                              uint8_t source_ip[4], uint16_t *source_port)
{
    if (getSn_RX_RSR(MDNS_SOCKET) < 8u) {
        return 0;
    }

    uint8_t header[8];
    uint16_t read_pointer = getSn_RX_RD(MDNS_SOCKET);
    wiz_recv_data(MDNS_SOCKET, header, sizeof(header));
    read_pointer += sizeof(header);
    setSn_RX_RD(MDNS_SOCKET, read_pointer);

    memcpy(source_ip, header, 4);
    *source_port = (uint16_t)header[4] << 8 | header[5];
    uint16_t packet_length = (uint16_t)header[6] << 8 | header[7];
    uint16_t copied = packet_length < capacity ? packet_length : capacity;
    if (copied != 0) {
        wiz_recv_data(MDNS_SOCKET, destination, copied);
    }
    setSn_RX_RD(MDNS_SOCKET, read_pointer + packet_length);
    return issue_socket_command(Sn_CR_RECV) ? copied : -1;
}

static bool send_packet(const uint8_t *packet, uint16_t length,
                        const uint8_t destination_ip[4],
                        uint16_t destination_port)
{
    if (length == 0 || length > getSn_TX_FSR(MDNS_SOCKET)) {
        return false;
    }
    setSn_DIPR(MDNS_SOCKET, destination_ip);
    setSn_DPORT(MDNS_SOCKET, destination_port);
    uint8_t pending = getSn_IR(MDNS_SOCKET) &
                      (Sn_IR_SENDOK | Sn_IR_TIMEOUT);
    if (pending != 0) {
        setSn_IR(MDNS_SOCKET, pending);
    }
    wiz_send_data(MDNS_SOCKET, (uint8_t *)packet, length);
    return issue_socket_command(Sn_CR_SEND);
}

static void write_u16(uint8_t *destination, uint16_t value)
{
    destination[0] = (uint8_t)(value >> 8);
    destination[1] = (uint8_t)value;
}

static void write_u32(uint8_t *destination, uint32_t value)
{
    destination[0] = (uint8_t)(value >> 24);
    destination[1] = (uint8_t)(value >> 16);
    destination[2] = (uint8_t)(value >> 8);
    destination[3] = (uint8_t)value;
}

static uint16_t read_u16(const uint8_t *source)
{
    return (uint16_t)((uint16_t)source[0] << 8 | source[1]);
}

static bool encode_hostname(const char *hostname)
{
    size_t hostname_length = strlen(hostname);
    static const char local_label[] = "local";
    if (hostname_length == 0 || hostname_length > 48) {
        return false;
    }

    encoded_name[0] = (uint8_t)hostname_length;
    memcpy(encoded_name + 1, hostname, hostname_length);
    encoded_name[hostname_length + 1] = sizeof(local_label) - 1;
    memcpy(encoded_name + hostname_length + 2, local_label,
           sizeof(local_label) - 1);
    encoded_name[hostname_length + 2 + sizeof(local_label) - 1] = 0;
    encoded_name_length =
        hostname_length + 2 + sizeof(local_label);
    return true;
}

static bool names_equal(const uint8_t *candidate, size_t length)
{
    if (length != encoded_name_length) {
        return false;
    }
    for (size_t i = 0; i < encoded_name_length; ++i) {
        uint8_t expected = encoded_name[i];
        uint8_t actual = candidate[i];
        if (isalpha(expected)) {
            expected = (uint8_t)tolower(expected);
            actual = (uint8_t)tolower(actual);
        }
        if (actual != expected) {
            return false;
        }
    }
    return true;
}

static bool decode_name_matches(const uint8_t *packet, size_t packet_length,
                                size_t start, size_t *consumed,
                                bool *matches)
{
    uint8_t decoded[sizeof(encoded_name)];
    size_t decoded_length = 0;
    size_t position = start;
    size_t original_consumed = 0;
    bool jumped = false;
    size_t iterations = 0;

    while (position < packet_length && iterations++ < packet_length) {
        uint8_t label_length = packet[position];
        if ((label_length & 0xc0u) == 0xc0u) {
            if (position + 1 >= packet_length) {
                return false;
            }
            size_t pointer =
                (size_t)(label_length & 0x3fu) << 8 | packet[position + 1];
            if (pointer >= packet_length) {
                return false;
            }
            if (!jumped) {
                original_consumed += 2;
            }
            position = pointer;
            jumped = true;
            continue;
        }
        if ((label_length & 0xc0u) != 0 || label_length > 63) {
            return false;
        }
        if (label_length == 0) {
            if (decoded_length >= sizeof(decoded)) {
                return false;
            }
            decoded[decoded_length++] = 0;
            if (!jumped) {
                ++original_consumed;
            }
            *consumed = original_consumed;
            *matches = names_equal(decoded, decoded_length);
            return true;
        }
        if (position + 1 + label_length > packet_length ||
            decoded_length + 1 + label_length >= sizeof(decoded)) {
            return false;
        }
        decoded[decoded_length++] = label_length;
        memcpy(decoded + decoded_length, packet + position + 1, label_length);
        decoded_length += label_length;
        if (!jumped) {
            original_consumed += 1 + label_length;
        }
        position += 1 + label_length;
    }
    return false;
}

static bool query_requests_our_address(const uint8_t *packet, size_t length,
                                       bool *unicast_requested)
{
    if (length < 12) {
        return false;
    }

    uint16_t question_count = read_u16(packet + 4);
    size_t offset = 12;
    for (uint16_t question = 0; question < question_count; ++question) {
        size_t name_length;
        bool matches;
        if (!decode_name_matches(packet, length, offset, &name_length,
                                 &matches)) {
            return false;
        }
        offset += name_length;
        if (offset + 4 > length) {
            return false;
        }

        uint16_t type = read_u16(packet + offset);
        uint16_t raw_class = read_u16(packet + offset + 2);
        uint16_t query_class = raw_class & 0x7fffu;
        offset += 4;

        if (matches && (type == 1 || type == 255) && query_class == 1) {
            *unicast_requested = (raw_class & 0x8000u) != 0;
            return true;
        }
    }
    return false;
}

static bool open_multicast_socket(void)
{
    if (getSn_SR(MDNS_SOCKET) != SOCK_CLOSED &&
        !issue_socket_command(Sn_CR_CLOSE)) {
        return false;
    }
    setSn_DHAR(MDNS_SOCKET, multicast_mac);
    setSn_DIPR(MDNS_SOCKET, multicast_ip);
    setSn_DPORT(MDNS_SOCKET, MDNS_PORT);
    setSn_TTL(MDNS_SOCKET, 255);
    setSn_MR(MDNS_SOCKET, Sn_MR_UDP | SF_MULTI_ENABLE);
    setSn_PORT(MDNS_SOCKET, MDNS_PORT);
    return issue_socket_command(Sn_CR_OPEN) &&
           getSn_SR(MDNS_SOCKET) == SOCK_UDP;
}

bool mdns_responder_init(const char *hostname)
{
    if (!encode_hostname(hostname)) {
        return false;
    }
    return open_multicast_socket();
}

void mdns_responder_stop(void)
{
    (void)issue_socket_command(Sn_CR_CLOSE);
}

void mdns_responder_service(const uint8_t ip[4])
{
    if (encoded_name_length == 0) {
        return;
    }
    if (getSn_SR(MDNS_SOCKET) != SOCK_UDP) {
        open_multicast_socket();
        return;
    }

    uint16_t available = getSn_RX_RSR(MDNS_SOCKET);
    if (available == 0) {
        return;
    }

    uint8_t query[MDNS_BUFFER_SIZE];
    uint8_t source_ip[4];
    uint16_t source_port;
    int32_t received =
        receive_packet(query, sizeof(query), source_ip, &source_port);
    bool unicast_requested = false;
    if (received <= 0 || !query_requests_our_address(
                             query, (size_t)received, &unicast_requested)) {
        return;
    }

    uint8_t response[12 + sizeof(encoded_name) + 14];
    memset(response, 0, 12);
    response[2] = 0x84;
    write_u16(response + 6, 1);

    size_t offset = 12;
    memcpy(response + offset, encoded_name, encoded_name_length);
    offset += encoded_name_length;
    write_u16(response + offset, 1);
    write_u16(response + offset + 2, 0x8001);
    write_u32(response + offset + 4, MDNS_TTL_SECONDS);
    write_u16(response + offset + 8, 4);
    memcpy(response + offset + 10, ip, 4);
    offset += 14;

    uint8_t *destination_ip =
        unicast_requested ? source_ip : multicast_ip;
    uint16_t destination_port =
        unicast_requested ? source_port : MDNS_PORT;
    if (!send_packet(response, (uint16_t)offset,
                     destination_ip, destination_port)) {
        // Recreate the UDP socket after a cable pull or W5500 socket error so
        // that the next reconnect attempt can resolve pico-motor.local again.
        open_multicast_socket();
    }
}

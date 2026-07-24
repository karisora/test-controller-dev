#ifndef MDNS_RESPONDER_H
#define MDNS_RESPONDER_H

#include <stdbool.h>
#include <stdint.h>

bool mdns_responder_init(const char *hostname);
void mdns_responder_service(const uint8_t ip[4]);
void mdns_responder_stop(void);

#endif

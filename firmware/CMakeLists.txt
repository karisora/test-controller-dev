cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD pico2 CACHE STRING "Board type")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(pico_sdk_import.cmake)

project(pico_lan_stepper C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

include(FetchContent)
if(POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)
endif()
FetchContent_Declare(
  iolibrary_driver
  GIT_REPOSITORY https://github.com/Wiznet/ioLibrary_Driver.git
  GIT_TAG v3.2.0
  GIT_SHALLOW TRUE
)
FetchContent_GetProperties(iolibrary_driver)
if(NOT iolibrary_driver_POPULATED)
  FetchContent_Populate(iolibrary_driver)
endif()

add_executable(pico_lan_stepper
  honda.c
  mdns_responder.c
  w5500_ethernet.c
  ${iolibrary_driver_SOURCE_DIR}/Ethernet/socket.c
  ${iolibrary_driver_SOURCE_DIR}/Ethernet/wizchip_conf.c
  ${iolibrary_driver_SOURCE_DIR}/Ethernet/W5500/w5500.c
  ${iolibrary_driver_SOURCE_DIR}/Internet/DHCP/dhcp.c
)

pico_generate_pio_header(pico_lan_stepper
  ${CMAKE_CURRENT_LIST_DIR}/stepper.pio
)

target_include_directories(pico_lan_stepper PRIVATE
  ${CMAKE_CURRENT_LIST_DIR}
  ${iolibrary_driver_SOURCE_DIR}/Ethernet
  ${iolibrary_driver_SOURCE_DIR}/Ethernet/W5500
  ${iolibrary_driver_SOURCE_DIR}/Internet/DHCP
)

target_compile_definitions(pico_lan_stepper PRIVATE
  _WIZCHIP_=W5500
  MAX_SPEED_STEPS_PER_SEC=20000
  MOTOR_API_WATCHDOG_MS=500
  MOTOR_HOSTNAME="pico-motor"
  MOTOR_FIRMWARE_VERSION="2026.07.24.14"
)

target_link_libraries(pico_lan_stepper
  pico_stdlib
  pico_unique_id
  hardware_clocks
  hardware_pio
  hardware_spi
)

pico_enable_stdio_usb(pico_lan_stepper 1)
pico_enable_stdio_uart(pico_lan_stepper 0)
pico_add_extra_outputs(pico_lan_stepper)

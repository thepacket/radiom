/* Minimal replacement for LinuxALE's server.h. The original pulled in
 * pthread + BSD sockets + multi-client dispatch; we just need the
 * Command_line_options struct + send_server() declaration that modem.c
 * references. send_server() is a no-op stub in main.c. */
#ifndef __SERVER_H__
#define __SERVER_H__

#include <stdio.h>

typedef struct {
  unsigned char silent;
  unsigned char cs_enable;
  FILE *write_file_fd;
  unsigned char write_server;
  int port_num;
  int interface_num;
  int soundcard_fd;
} command_line_options;

extern command_line_options Command_line_options;

void send_server(char*);

#endif

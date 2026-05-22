/* Driver for the LinuxALE-vendored ALE 2G (MIL-STD-188-141B) decoder.
 *
 * Reads 12 kHz signed-16-bit little-endian PCM from stdin, linearly
 * resamples to 8 kHz (LinuxALE's expected rate), batches into 200-sample
 * FRAMEs, and feeds the vendored modem(). Decoded ALE words come out
 * via output_mesg() in modem.c, which writes lines to stdout.
 *
 * No CLI flags — keep it simple, mirror the cw/navtex/wefax pattern.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "server.h"     /* command_line_options + Command_line_options */
#include "dblookup.h"   /* search_db / db_init stubs */

/* Forward declarations of the modem entry points. We can't include
 * modem.h here because it defines storage (ASCII_Set, preamble_types,
 * symbol_lookup, vote_lookup) at file scope — including it in two
 * translation units would cause multi-definition link errors. */
void modem_init(void);
void modem(unsigned short *samples, int n, FILE *log_file);

/* Backing storage for the global referenced by modem.c. */
command_line_options Command_line_options = {
  .silent       = 0,    /* keep stdout output enabled */
  .cs_enable    = 0,    /* no callsign DB */
  .write_file_fd = NULL,
  .write_server = 0,
  .port_num     = 0,
  .interface_num= 0,
  .soundcard_fd = 0,
};

/* No-op stubs for symbols modem.c references but never reaches because
 * the corresponding flags are zero. */
void  send_server(char *msg) { (void)msg; }
char* search_db (char *msg)  { (void)msg; return NULL; }
int   db_init  (void)        { return 0; }
void  close_db (void)        { }

#define IN_RATE   12000.0
#define OUT_RATE   8000.0
#define FRAME_SAMPLES 200    /* must match LinuxALE's FRAME_SIZE */

int main(int argc, char **argv) {
  (void)argc; (void)argv;

  /* Line-buffer stdout so each decoded line reaches the WS bridge as
   * soon as it's emitted, not after a 4 KiB block fills. */
  setvbuf(stdout, NULL, _IOLBF, 0);

  modem_init();

  /* Linear resampler state for 12 kHz → 8 kHz. */
  double phase  = 0.0;
  double prev   = 0.0;
  int    primed = 0;
  const double step = IN_RATE / OUT_RATE;  /* = 1.5 */

  /* 200-sample output frame in unsigned short (matches modem signature;
   * the modem treats it as signed int16 internally — we keep the bit
   * pattern unchanged, just reinterpret). */
  unsigned short frame[FRAME_SAMPLES];
  int frame_pos = 0;

  /* Read int16 LE from stdin in chunks. */
  int16_t in_buf[1024];
  ssize_t r;
  while ((r = read(0, in_buf, sizeof in_buf)) > 0) {
    int n = r / 2;
    for (int i = 0; i < n; i++) {
      double cur = (double)in_buf[i];
      while (phase < 1.0) {
        double s = primed ? prev + (cur - prev) * phase : cur;
        if (s >  32767.0) s =  32767.0;
        if (s < -32768.0) s = -32768.0;
        frame[frame_pos++] = (unsigned short)(int16_t)s;
        if (frame_pos == FRAME_SAMPLES) {
          modem(frame, FRAME_SAMPLES, NULL);
          frame_pos = 0;
        }
        phase += step;
      }
      phase -= 1.0;
      prev   = cur;
      primed = 1;
    }
  }
  return 0;
}

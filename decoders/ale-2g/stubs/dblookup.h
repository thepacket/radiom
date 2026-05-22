/* Minimal replacement for LinuxALE's dblookup.h. The original loaded a
 * basenames file and resolved 3-letter ALE addresses to human names; we
 * stub it out. modem.c only calls search_db() when cs_enable is set,
 * which we leave at 0 in main.c — but provide a stub anyway. */
#ifndef __DBLOOKUP_H__
#define __DBLOOKUP_H__

char* search_db(char*);
int   db_init(void);
void  close_db(void);

#endif

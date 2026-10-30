/* Positive/negative control of a candidate seatbelt profile, not a renderer. */
#include <sys/socket.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    errno = 0; int r = open(argv[1], O_RDONLY); int er = r < 0 ? errno : 0; if (r >= 0) close(r);
    errno = 0; int w = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600); int ew = w < 0 ? errno : 0; if (w >= 0) close(w);
    int s = socket(AF_INET, SOCK_STREAM, 0), ec = s < 0 ? errno : 0, rc = -1;
    if (s >= 0) { struct sockaddr_in a = {.sin_family=AF_INET, .sin_port=htons((unsigned short)atoi(argv[3]))}; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); errno=0; rc=connect(s,(struct sockaddr *)&a,sizeof(a)); ec=rc<0?errno:0; close(s); }
    printf("{\"read_allowed\":%s,\"read_errno\":%d,\"write_allowed\":%s,\"write_errno\":%d,\"network_allowed\":%s,\"network_errno\":%d}\n",r>=0?"true":"false",er,w>=0?"true":"false",ew,rc==0?"true":"false",ec);
    return 0;
}

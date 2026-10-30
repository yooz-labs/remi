/* Test-only per-process-limit counterexample. No production isolation claim. */
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define MIB (1024UL * 1024UL)
static void child(int report, int release) {
    alarm(5);
    struct rlimit limit = {384 * MIB, 384 * MIB};
    char outcome = 'L';
    if (setrlimit(RLIMIT_AS, &limit) != 0) { write(report, &outcome, 1); _exit(20); }
    char *memory = malloc(220 * MIB);
    if (!memory) { outcome = 'A'; write(report, &outcome, 1); _exit(21); }
    for (size_t i = 0; i < 220 * MIB; i += 4096) memory[i] = (char)i;
    outcome = 'S';
    if (write(report, &outcome, 1) != 1) _exit(22);
    char done;
    if (read(release, &done, 1) != 1) _exit(23);
    free(memory);
    _exit(0);
}
int main(void) {
    signal(SIGPIPE, SIG_IGN);
    int report[2], release[2];
    if (pipe(report) || pipe(release)) return 2;
    pid_t pids[2] = {-1,-1};
    alarm(8);
    for (int i = 0; i < 2; i++) {
        pids[i] = fork();
        if (pids[i] == 0) { close(report[0]); close(release[1]); child(report[1], release[0]); }
        if (pids[i] < 0) { for (int j = 0; j < i; j++) kill(pids[j], SIGKILL); while (wait(NULL) > 0) {} return 3; }
    }
    close(report[1]); close(release[0]);
    char outcomes[2] = {'?','?'};
    for (int i = 0; i < 2; i++) if (read(report[0], &outcomes[i], 1) != 1) break;
    ssize_t sent = write(release[1], "xx", 2);
    close(release[1]); close(report[0]);
    int statuses[2];
    for (int i = 0; i < 2; i++) waitpid(pids[i], &statuses[i], 0);
    alarm(0);
    /* Limit setup failure makes the counterexample inconclusive, not false. */
    const char *counterexample = outcomes[0]=='S' && outcomes[1]=='S' ? "true" : "null";
    printf("{\"per_process_limit_bytes\":%lu,\"requested_touched_bytes_each\":%lu,\"outcomes\":[\"%c\",\"%c\"],\"release_bytes\":%zd,\"exit_statuses\":[%d,%d],\"combined_touched_above_tree_cap\":%s}\n", 384*MIB, 220*MIB, outcomes[0], outcomes[1], sent, statuses[0], statuses[1], counterexample);
    return 0;
}

/* [TARGET, unit decision] Fail on libc clock/network/process dependencies.
 * strace also denies network syscalls, including direct syscall callers.
 * The probe build proves this interposer was loaded and rejects each class. */
#define _GNU_SOURCE
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#ifdef REPLAY_DENY_PROBE
extern char **environ;
int main(int argc, char **argv) {
    if (argc != 2) return 65;
    if (strcmp(argv[1], "clock") == 0) {
        struct timespec result;
        return clock_gettime(CLOCK_MONOTONIC, &result) == 0 ? 0 : 66;
    }
    if (strcmp(argv[1], "network") == 0) return socket(AF_UNIX, SOCK_STREAM, 0) >= 0 ? 0 : 66;
    if (strcmp(argv[1], "model") == 0) {
        char *child[] = {argv[0], "returned", NULL};
        return execve(argv[0], child, environ);
    }
    return 67;
}
#else
static void deny(const char *message) {
    (void)write(STDERR_FILENO, message, strlen(message));
    _exit(97);
}
int clock_gettime(clockid_t id, struct timespec *result) {
    (void)id; (void)result; deny("E2E_PURITY_DENIED: clock\n"); return -1;
}
int gettimeofday(struct timeval *result, void *zone) {
    (void)result; (void)zone; deny("E2E_PURITY_DENIED: clock\n"); return -1;
}
time_t time(time_t *result) {
    (void)result; deny("E2E_PURITY_DENIED: clock\n"); return (time_t)-1;
}
int socket(int domain, int type, int protocol) {
    (void)domain; (void)type; (void)protocol; deny("E2E_PURITY_DENIED: network\n"); return -1;
}
int connect(int fd, const struct sockaddr *address, socklen_t length) {
    (void)fd; (void)address; (void)length; deny("E2E_PURITY_DENIED: network\n"); return -1;
}
int execve(const char *path, char *const argv[], char *const env[]) {
    (void)path; (void)argv; (void)env; deny("E2E_PURITY_DENIED: model\n"); return -1;
}
#endif

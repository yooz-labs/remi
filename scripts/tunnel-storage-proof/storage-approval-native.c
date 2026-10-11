/* #1170 proof-only fixed wrappers over the descriptor-relative libc calls. */
extern int openat(int, const char *, int, ...);
extern int linkat(int, const char *, int, const char *, int);
extern int unlinkat(int, const char *, int);

int remi_approval_openat(int directory, const char *name, int flags) {
    return openat(directory, name, flags);
}

int remi_approval_create(int directory, const char *name, int flags, int mode) {
    return openat(directory, name, flags, mode);
}

int remi_approval_linkat(int directory, const char *from, const char *to) {
    return linkat(directory, from, directory, to, 0);
}

int remi_approval_unlinkat(int directory, const char *name) {
    return unlinkat(directory, name, 0);
}

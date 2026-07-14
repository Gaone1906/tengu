#define _DARWIN_C_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif
#ifndef O_NONBLOCK
#define O_NONBLOCK 0
#endif

static void fail(const char *message) {
  fprintf(stderr, "%s: %s\n", message, strerror(errno));
  exit(2);
}

static void hex_path(const char *path) {
  const unsigned char *cursor = (const unsigned char *)path;
  while (*cursor) {
    printf("%02x", *cursor);
    cursor++;
  }
}

static int safe_segment(const char *segment) {
  return segment[0] != '\0' && strcmp(segment, ".") != 0 && strcmp(segment, "..") != 0
    && strchr(segment, '/') == NULL;
}

static void list_dir(int directory_fd, const char *prefix, size_t depth, size_t *count, size_t max_files) {
  if (depth > 32) { errno = ELOOP; fail("artifact tree is too deep"); }
  int copy = dup(directory_fd);
  if (copy < 0) fail("dup directory");
  DIR *directory = fdopendir(copy);
  if (!directory) { close(copy); fail("fdopendir"); }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!safe_segment(entry->d_name)) { closedir(directory); errno = EINVAL; fail("unsafe artifact name"); }
    char relative[4096];
    int written = prefix[0] == '\0'
      ? snprintf(relative, sizeof(relative), "%s", entry->d_name)
      : snprintf(relative, sizeof(relative), "%s/%s", prefix, entry->d_name);
    if (written < 0 || (size_t)written >= sizeof(relative)) { closedir(directory); errno = ENAMETOOLONG; fail("artifact path too long"); }
    struct stat info;
    if (fstatat(directory_fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) { closedir(directory); fail("fstatat"); }
    if (S_ISLNK(info.st_mode)) {
      printf("L\t0\t"); hex_path(relative); printf("\n");
    } else if (S_ISDIR(info.st_mode)) {
      printf("D\t0\t"); hex_path(relative); printf("\n");
      int child = openat(directory_fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
      if (child < 0) { closedir(directory); fail("openat directory"); }
      list_dir(child, relative, depth + 1, count, max_files);
      close(child);
    } else if (S_ISREG(info.st_mode)) {
      *count += 1;
      if (*count > max_files) { closedir(directory); errno = EFBIG; fail("too many artifact files"); }
      printf("F\t%lld\t", (long long)info.st_size); hex_path(relative); printf("\n");
    } else {
      printf("S\t0\t"); hex_path(relative); printf("\n");
    }
  }
  closedir(directory);
}

static int open_relative(int root_fd, const char *relative) {
  if (!relative || relative[0] == '/' || relative[0] == '\0' || strstr(relative, "//") || relative[strlen(relative) - 1] == '/') {
    errno = EINVAL; fail("unsafe relative path");
  }
  char *copy = strdup(relative);
  if (!copy) fail("strdup");
  int current = dup(root_fd);
  if (current < 0) { free(copy); fail("dup root"); }
  char *save = NULL;
  char *segment = strtok_r(copy, "/", &save);
  while (segment) {
    if (!safe_segment(segment)) { close(current); free(copy); errno = EINVAL; fail("unsafe path segment"); }
    char *next = strtok_r(NULL, "/", &save);
    int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
    if (next) flags |= O_DIRECTORY;
    int opened = openat(current, segment, flags);
    if (opened < 0) { close(current); free(copy); fail("openat artifact"); }
    close(current);
    current = opened;
    segment = next;
  }
  free(copy);
  return current;
}

static int open_destination_parent(int root_fd, const char *relative, char **leaf_out) {
  if (!relative || relative[0] == '/' || relative[0] == '\0' || strstr(relative, "//") || relative[strlen(relative) - 1] == '/') {
    errno = EINVAL; fail("unsafe destination path");
  }
  char *copy = strdup(relative);
  if (!copy) fail("strdup");
  int current = dup(root_fd);
  if (current < 0) { free(copy); fail("dup destination root"); }
  char *save = NULL;
  char *segment = strtok_r(copy, "/", &save);
  while (segment) {
    if (!safe_segment(segment)) { close(current); free(copy); errno = EINVAL; fail("unsafe destination segment"); }
    char *next = strtok_r(NULL, "/", &save);
    if (!next) {
      *leaf_out = strdup(segment);
      if (!*leaf_out) { close(current); free(copy); fail("strdup destination leaf"); }
      free(copy);
      return current;
    }
    if (mkdirat(current, segment, 0700) != 0 && errno != EEXIST) {
      close(current); free(copy); fail("mkdirat destination");
    }
    int opened = openat(current, segment, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (opened < 0) { close(current); free(copy); fail("openat destination directory"); }
    close(current);
    current = opened;
    segment = next;
  }
  close(current);
  free(copy);
  errno = EINVAL;
  fail("missing destination leaf");
  return -1;
}

static void copy_relative(int source_root, int destination_root, const char *relative, unsigned long long max_size) {
  int source = open_relative(source_root, relative);
  struct stat info;
  if (fstat(source, &info) != 0) { close(source); fail("fstat source artifact"); }
  if (!S_ISREG(info.st_mode) || (unsigned long long)info.st_size > max_size) {
    close(source); errno = EFBIG; fail("source artifact is not a bounded regular file");
  }
  char *leaf = NULL;
  int parent = open_destination_parent(destination_root, relative, &leaf);
  int destination = openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  free(leaf);
  close(parent);
  if (destination < 0) { close(source); fail("create restored artifact"); }
  char buffer[16384];
  ssize_t read_count;
  while ((read_count = read(source, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < read_count) {
      ssize_t wrote = write(destination, buffer + offset, (size_t)(read_count - offset));
      if (wrote < 0) { close(source); close(destination); fail("write restored artifact"); }
      offset += wrote;
    }
  }
  if (read_count < 0) { close(source); close(destination); fail("read source artifact"); }
  if (fsync(destination) != 0) { close(source); close(destination); fail("fsync restored artifact"); }
  close(source);
  close(destination);
}

int main(int argc, char **argv) {
  if (argc < 3) return 64;
  int root = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (root < 0) fail("open artifact root");
  if (strcmp(argv[1], "list") == 0 && argc == 4) {
    char *end = NULL;
    unsigned long long parsed = strtoull(argv[3], &end, 10);
    if (!end || *end != '\0' || parsed == 0 || parsed > 1000000) { close(root); return 64; }
    size_t count = 0;
    list_dir(root, "", 0, &count, (size_t)parsed);
    close(root);
    return 0;
  }
  if (strcmp(argv[1], "read") == 0 && argc == 5) {
    char *end = NULL;
    unsigned long long max_size = strtoull(argv[4], &end, 10);
    if (!end || *end != '\0' || max_size == 0) { close(root); return 64; }
    int file = open_relative(root, argv[3]);
    close(root);
    struct stat info;
    if (fstat(file, &info) != 0) { close(file); fail("fstat artifact"); }
    if (!S_ISREG(info.st_mode) || (unsigned long long)info.st_size > max_size) { close(file); errno = EFBIG; fail("artifact is not a bounded regular file"); }
    char buffer[16384];
    ssize_t read_count;
    while ((read_count = read(file, buffer, sizeof(buffer))) > 0) {
      ssize_t offset = 0;
      while (offset < read_count) {
        ssize_t wrote = write(STDOUT_FILENO, buffer + offset, (size_t)(read_count - offset));
        if (wrote < 0) { close(file); fail("write artifact"); }
        offset += wrote;
      }
    }
    if (read_count < 0) { close(file); fail("read artifact"); }
    close(file);
    return 0;
  }
  if (strcmp(argv[1], "copy") == 0 && argc == 6) {
    char *end = NULL;
    unsigned long long max_size = strtoull(argv[5], &end, 10);
    if (!end || *end != '\0' || max_size == 0) { close(root); return 64; }
    int destination_root = open(argv[3], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (destination_root < 0) { close(root); fail("open destination root"); }
    copy_relative(root, destination_root, argv[4], max_size);
    close(destination_root);
    close(root);
    return 0;
  }
  close(root);
  return 64;
}

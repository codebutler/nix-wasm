#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int release_path(const char *path)
{
	struct stat st;
	DIR *dir;
	struct dirent *entry;
	int failed = 0;

	if (lstat(path, &st) < 0) {
		fprintf(stderr, "seed-cache-release: lstat %s: %s\n", path,
			strerror(errno));
		return -1;
	}

	if (S_ISREG(st.st_mode)) {
		int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
		int error;

		if (fd < 0) {
			fprintf(stderr, "seed-cache-release: open %s: %s\n", path,
				strerror(errno));
			return -1;
		}
		error = posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
		if (error != 0) {
			fprintf(stderr, "seed-cache-release: fadvise %s: %s\n", path,
				strerror(error));
			failed = -1;
		}
		close(fd);
		return failed;
	}

	if (!S_ISDIR(st.st_mode))
		return 0;

	dir = opendir(path);
	if (dir == NULL) {
		fprintf(stderr, "seed-cache-release: opendir %s: %s\n", path,
			strerror(errno));
		return -1;
	}
	while ((entry = readdir(dir)) != NULL) {
		char *child;
		size_t length;

		if (strcmp(entry->d_name, ".") == 0 ||
		    strcmp(entry->d_name, "..") == 0)
			continue;
		length = strlen(path) + 1 + strlen(entry->d_name) + 1;
		child = malloc(length);
		if (child == NULL) {
			fprintf(stderr, "seed-cache-release: out of memory below %s\n", path);
			failed = -1;
			break;
		}
		snprintf(child, length, "%s/%s", path, entry->d_name);
		if (release_path(child) < 0)
			failed = -1;
		free(child);
	}
	closedir(dir);
	return failed;
}

int main(int argc, char **argv)
{
	int mount_fd;
	int failed = 0;
	int i;

	if (argc < 3) {
		fprintf(stderr,
			"usage: seed-cache-release MOUNT-POINT PATH [PATH ...]\n");
		return 2;
	}

	/* Make destination data clean before DONTNEED can discard its cache pages. */
	mount_fd = open(argv[1], O_RDONLY | O_CLOEXEC | O_DIRECTORY);
	if (mount_fd < 0) {
		fprintf(stderr, "seed-cache-release: open mount %s: %s\n", argv[1],
			strerror(errno));
		return 1;
	}
	if (syncfs(mount_fd) < 0) {
		fprintf(stderr, "seed-cache-release: syncfs %s: %s\n", argv[1],
			strerror(errno));
		close(mount_fd);
		return 1;
	}
	close(mount_fd);

	for (i = 2; i < argc; ++i) {
		if (release_path(argv[i]) < 0)
			failed = 1;
	}
	return failed;
}

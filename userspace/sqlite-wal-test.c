/* sqlite-wal-test — #131 SQLite memory-model regression test.
 *
 * The old wasm package forced SQLITE_OMIT_WAL and SQLITE_THREADSAFE=0 because
 * NOMMU could not grow a shared mmap. Both supported kernels now provide a
 * growable MAP_SHARED ramfs mapping. Prove the restored library can select WAL
 * and serialize genuinely concurrent writers on both ramfs mounts.
 *
 * `--probe-db PATH` is used after a real `nix-env` install to verify that Nix's
 * actual store database persisted WAL mode with this same sqlite library. */
#define _GNU_SOURCE
#include <pthread.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define WORKERS 4
#define ROWS_PER_WORKER 24

struct start_gate {
  pthread_mutex_t mutex;
  pthread_cond_t cond;
  int ready;
  int go;
};

struct worker_arg {
  const char *path;
  int id;
  int rc;
  struct start_gate *gate;
};

static int capture_text(void *opaque, int columns, char **values, char **names) {
  (void)names;
  if (columns > 0 && values[0])
    snprintf(opaque, 16, "%s", values[0]);
  return 0;
}

static int exec_sql(sqlite3 *db, const char *sql) {
  char *error = NULL;
  int rc = sqlite3_exec(db, sql, NULL, NULL, &error);
  if (rc != SQLITE_OK) {
    fprintf(stderr, "sqlite exec failed rc=%d sql=%s error=%s\n", rc, sql,
            error ? error : sqlite3_errmsg(db));
    sqlite3_free(error);
  }
  return rc;
}

static int begin_immediate(sqlite3 *db) {
  for (int attempt = 0; attempt < 20; ++attempt) {
    int rc = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL);
    if (rc == SQLITE_OK)
      return rc;
    if (rc != SQLITE_BUSY && rc != SQLITE_LOCKED)
      return rc;
    usleep(10000);
  }
  return SQLITE_BUSY;
}

static void *writer(void *opaque) {
  struct worker_arg *arg = opaque;
  sqlite3 *db = NULL;
  sqlite3_stmt *stmt = NULL;
  arg->rc = SQLITE_ERROR;

  /* Join the start gate before any operation that can fail, so the parent can
   * never wait forever for a worker whose sqlite3_open_v2() returned early. */
  pthread_mutex_lock(&arg->gate->mutex);
  ++arg->gate->ready;
  /* Parent and workers wait on this condition for different predicates; wake
   * all so a readiness notification cannot be consumed by another worker. */
  pthread_cond_broadcast(&arg->gate->cond);
  while (!arg->gate->go)
    pthread_cond_wait(&arg->gate->cond, &arg->gate->mutex);
  pthread_mutex_unlock(&arg->gate->mutex);

  int rc = sqlite3_open_v2(arg->path, &db,
                           SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, NULL);
  if (rc != SQLITE_OK)
    goto out;
  sqlite3_busy_timeout(db, 20000);

  rc = begin_immediate(db);
  if (rc != SQLITE_OK)
    goto out;
  rc = sqlite3_prepare_v2(db, "INSERT INTO writes(worker, seq) VALUES(?1, ?2)",
                          -1, &stmt, NULL);
  if (rc != SQLITE_OK)
    goto rollback;
  for (int seq = 0; seq < ROWS_PER_WORKER; ++seq) {
    sqlite3_bind_int(stmt, 1, arg->id);
    sqlite3_bind_int(stmt, 2, seq);
    rc = sqlite3_step(stmt);
    if (rc != SQLITE_DONE)
      goto rollback;
    sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    usleep(2000); /* keep transactions overlapping long enough to contend */
  }
  sqlite3_finalize(stmt);
  stmt = NULL;
  rc = exec_sql(db, "COMMIT");
  if (rc == SQLITE_OK)
    arg->rc = SQLITE_OK;
  goto out;

rollback:
  sqlite3_finalize(stmt);
  stmt = NULL;
  sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
out:
  sqlite3_finalize(stmt);
  sqlite3_close(db);
  return NULL;
}

static void remove_db(const char *path) {
  char sidecar[256];
  unlink(path);
  snprintf(sidecar, sizeof(sidecar), "%s-wal", path);
  unlink(sidecar);
  snprintf(sidecar, sizeof(sidecar), "%s-shm", path);
  unlink(sidecar);
}

static int query_journal_mode(sqlite3 *db, char mode[16]) {
  mode[0] = '\0';
  char *error = NULL;
  int rc = sqlite3_exec(db, "PRAGMA journal_mode", capture_text, mode, &error);
  if (rc != SQLITE_OK) {
    fprintf(stderr, "journal_mode query failed: %s\n",
            error ? error : sqlite3_errmsg(db));
    sqlite3_free(error);
  }
  return rc;
}

static int test_path(const char *path) {
  sqlite3 *db = NULL;
  sqlite3_stmt *stmt = NULL;
  pthread_t threads[WORKERS];
  struct worker_arg args[WORKERS];
  struct start_gate gate = {PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER,
                            0, 0};
  char mode[16] = {0};
  char wal[256], shm[256];
  int count = -1;
  int created = 0;
  int failed = 1;

  remove_db(path);
  int rc = sqlite3_open_v2(path, &db,
                           SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                               SQLITE_OPEN_FULLMUTEX,
                           NULL);
  if (rc != SQLITE_OK)
    goto out;
  sqlite3_busy_timeout(db, 20000);

  rc = sqlite3_exec(db, "PRAGMA journal_mode=WAL", capture_text, mode, NULL);
  if (rc != SQLITE_OK || strcmp(mode, "wal") != 0)
    goto out;
  if (exec_sql(db,
               "CREATE TABLE writes(worker INTEGER, seq INTEGER, "
               "PRIMARY KEY(worker, seq))") != SQLITE_OK)
    goto out;

  for (int i = 0; i < WORKERS; ++i) {
    args[i] = (struct worker_arg){path, i, SQLITE_ERROR, &gate};
    if (pthread_create(&threads[i], NULL, writer, &args[i]) != 0)
      goto join;
    ++created;
  }

  pthread_mutex_lock(&gate.mutex);
  while (gate.ready != WORKERS)
    pthread_cond_wait(&gate.cond, &gate.mutex);
  gate.go = 1;
  pthread_cond_broadcast(&gate.cond);
  pthread_mutex_unlock(&gate.mutex);

join:
  if (created != WORKERS) {
    pthread_mutex_lock(&gate.mutex);
    gate.go = 1;
    pthread_cond_broadcast(&gate.cond);
    pthread_mutex_unlock(&gate.mutex);
  }
  for (int i = 0; i < created; ++i)
    pthread_join(threads[i], NULL);
  if (created != WORKERS)
    goto out;
  for (int i = 0; i < WORKERS; ++i)
    if (args[i].rc != SQLITE_OK)
      goto out;

  rc = sqlite3_prepare_v2(db, "SELECT count(*) FROM writes", -1, &stmt, NULL);
  if (rc != SQLITE_OK || sqlite3_step(stmt) != SQLITE_ROW)
    goto out;
  count = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);
  stmt = NULL;
  if (count != WORKERS * ROWS_PER_WORKER)
    goto out;
  if (query_journal_mode(db, mode) != SQLITE_OK || strcmp(mode, "wal") != 0)
    goto out;

  snprintf(wal, sizeof(wal), "%s-wal", path);
  snprintf(shm, sizeof(shm), "%s-shm", path);
  if (access(wal, F_OK) != 0 || access(shm, F_OK) != 0)
    goto out;

  printf("SQLITE-WAL-TEST: %s threadsafe=%d journal=wal rows=%d wal+shm=OK\n",
         path, sqlite3_threadsafe(), count);
  failed = 0;
out:
  if (failed)
    printf("SQLITE-WAL-TEST: %s rc=%d mode=%s rows=%d FAIL\n", path, rc,
           mode, count);
  sqlite3_finalize(stmt);
  sqlite3_close(db);
  pthread_cond_destroy(&gate.cond);
  pthread_mutex_destroy(&gate.mutex);
  remove_db(path);
  return failed;
}

static int probe_store_db(const char *path) {
  sqlite3 *db = NULL;
  char mode[16] = {0};
  int rc = sqlite3_open_v2(path, &db,
                           SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, NULL);
  if (rc == SQLITE_OK)
    rc = query_journal_mode(db, mode);
  if (rc != SQLITE_OK || strcmp(mode, "wal") != 0 || sqlite3_threadsafe() == 0) {
    printf("SQLITE-STORE-DB: %s threadsafe=%d journal=%s rc=%d FAIL\n", path,
           sqlite3_threadsafe(), mode, rc);
    sqlite3_close(db);
    return 1;
  }
  printf("SQLITE-STORE-DB: %s threadsafe=%d journal=wal OK\n", path,
         sqlite3_threadsafe());
  sqlite3_close(db);
  return 0;
}

int main(int argc, char **argv) {
  if (sqlite3_threadsafe() == 0 || sqlite3_config(SQLITE_CONFIG_SERIALIZED) != SQLITE_OK) {
    printf("SQLITE-WAL-TEST: serialized threading unavailable FAIL\n");
    return 1;
  }
  if (argc == 3 && strcmp(argv[1], "--probe-db") == 0)
    return probe_store_db(argv[2]);
  if (argc != 1) {
    fprintf(stderr, "usage: %s [--probe-db PATH]\n", argv[0]);
    return 2;
  }
  return test_path("/tmp/sqlite-wal-test.db") ||
         test_path("/dev/shm/sqlite-wal-test.db");
}

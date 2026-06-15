#include <git2.h>
#include <git2/sys/odb_backend.h>
/* auto-generated fail-at-runtime stubs (#139): git2 not used for local nix-build */
int git_attr_get(const char **value_out, git_repository *repo, uint32_t flags, const char *path, const char *name) { return 0; }
int git_attr_get_ext(const char **value_out, git_repository *repo, git_attr_options *opts, const char *path, const char *name) { return 0; }
git_attr_value_t git_attr_value(const char *attr) { return 0; }
int git_blob_create_from_buffer(git_oid *id, git_repository *repo, const void *buffer, size_t len) { return 0; }
int git_blob_create_from_stream(git_writestream **out, git_repository *repo, const char *hintpath) { return 0; }
int git_blob_create_from_stream_commit(git_oid *out, git_writestream *stream) { return 0; }
void git_blob_free(git_blob *blob) {}
const void * git_blob_rawcontent(const git_blob *blob) { return 0; }
git_object_size_t git_blob_rawsize(const git_blob *blob) { return 0; }
void git_buf_dispose(git_buf *buffer) {}
void git_commit_free(git_commit *commit) {}
const git_oid * git_commit_id(const git_commit *commit) { return 0; }
const git_oid * git_commit_parent_id(const git_commit *commit, unsigned int n) { return 0; }
unsigned int git_commit_parentcount(const git_commit *commit) { return 0; }
git_time_t git_commit_time(const git_commit *commit) { return 0; }
void git_config_entry_free(git_config_entry *entry) {}
void git_config_free(git_config *cfg) {}
int git_config_get_entry(git_config_entry **out, const git_config *cfg, const char *name) { return 0; }
void git_config_iterator_free(git_config_iterator *iter) {}
int git_config_iterator_glob_new(git_config_iterator **out, const git_config *cfg, const char *regexp) { return 0; }
int git_config_next(git_config_entry **entry, git_config_iterator *iter) { return 0; }
int git_config_open_ondisk(git_config **out, const char *path) { return 0; }
const git_error * git_error_last(void) { return 0; }
int git_indexer_append(git_indexer *idx, const void *data, size_t size, git_indexer_progress *stats) { return 0; }
int git_indexer_commit(git_indexer *idx, git_indexer_progress *stats) { return 0; }
void git_indexer_free(git_indexer *idx) {}
int git_indexer_new(git_indexer **out, const char *path, unsigned int mode, git_odb *odb, git_indexer_options *opts) { return 0; }
int git_libgit2_init(void) { return 0; }
int git_mempack_new(git_odb_backend **out) { return 0; }
int git_mempack_reset(git_odb_backend *backend) { return 0; }
int git_mempack_write_thin_pack(git_odb_backend *backend, git_packbuilder *pb) { return 0; }
int git_object_dup(git_object **dest, git_object *source) { return 0; }
void git_object_free(git_object *object) {}
const git_oid * git_object_id(const git_object *obj) { return 0; }
int git_object_lookup(git_object **object, git_repository *repo, const git_oid *id, git_object_t type) { return 0; }
int git_object_peel(git_object **peeled, const git_object *object, git_object_t target_type) { return 0; }
git_object_t git_object_type(const git_object *obj) { return 0; }
int git_odb_add_backend(git_odb *odb, git_odb_backend *backend, int priority) { return 0; }
int git_odb_backend_pack(git_odb_backend **out, const char *objects_dir) { return 0; }
void git_odb_free(git_odb *db) {}
int git_odb_new(git_odb **odb) { return 0; }
int git_oid_equal(const git_oid *a, const git_oid *b) { return 0; }
int git_oid_fromstr(git_oid *out, const char *str) { return 0; }
char * git_oid_tostr_s(const git_oid *oid) { return 0; }
void git_packbuilder_free(git_packbuilder *pb) {}
int git_packbuilder_new(git_packbuilder **out, git_repository *repo) { return 0; }
int git_packbuilder_set_callbacks(git_packbuilder *pb, git_packbuilder_progress progress_cb, void *progress_cb_payload) { return 0; }
unsigned int git_packbuilder_set_threads(git_packbuilder *pb, unsigned int n) { return 0; }
int git_packbuilder_write_buf(git_buf *buf, git_packbuilder *pb) { return 0; }
void git_reference_free(git_reference *ref) {}
int git_reference_lookup(git_reference **out, git_repository *repo, const char *name) { return 0; }
int git_reference_name_to_id(git_oid *out, git_repository *repo, const char *name) { return 0; }
const char * git_reference_symbolic_target(const git_reference *ref) { return 0; }
int git_remote_lookup(git_remote **out, git_repository *repo, const char *name) { return 0; }
int git_remote_set_url(git_repository *repo, const char *remote, const char *url) { return 0; }
const char * git_remote_url(const git_remote *remote) { return 0; }
int git_repository_config(git_config **out, git_repository *repo) { return 0; }
void git_repository_free(git_repository *repo) {}
int git_repository_init(git_repository **out, const char *path, unsigned is_bare) { return 0; }
int git_repository_is_shallow(git_repository *repo) { return 0; }
int git_repository_odb(git_odb **out, git_repository *repo) { return 0; }
int git_repository_open(git_repository **out, const char *path) { return 0; }
const char * git_repository_path(const git_repository *repo) { return 0; }
int git_repository_set_odb(git_repository *repo, git_odb *odb) { return 0; }
int git_revparse_single(git_object **out, git_repository *repo, const char *spec) { return 0; }
int git_status_foreach_ext(git_repository *repo, const git_status_options *opts, git_status_cb callback, void *payload) { return 0; }
int git_submodule_resolve_url(git_buf *out, git_repository *repo, const char *url) { return 0; }
const git_tree_entry * git_tree_entry_byindex(const git_tree *tree, size_t idx) { return 0; }
int git_tree_entry_dup(git_tree_entry **dest, const git_tree_entry *source) { return 0; }
git_filemode_t git_tree_entry_filemode(const git_tree_entry *entry) { return 0; }
void git_tree_entry_free(git_tree_entry *entry) {}
const git_oid * git_tree_entry_id(const git_tree_entry *entry) { return 0; }
const char * git_tree_entry_name(const git_tree_entry *entry) { return 0; }
int git_tree_entry_to_object(git_object **object_out, git_repository *repo, const git_tree_entry *entry) { return 0; }
git_object_t git_tree_entry_type(const git_tree_entry *entry) { return 0; }
size_t git_tree_entrycount(const git_tree *tree) { return 0; }
void git_tree_free(git_tree *tree) {}
void git_treebuilder_free(git_treebuilder *bld) {}
int git_treebuilder_insert(const git_tree_entry **out, git_treebuilder *bld, const char *filename, const git_oid *id, git_filemode_t filemode) { return 0; }
int git_treebuilder_new(git_treebuilder **out, git_repository *repo, const git_tree *source) { return 0; }
int git_treebuilder_write(git_oid *id, git_treebuilder *bld) { return 0; }
int git_reference_name_is_valid(int *valid, const char *refname) { return 0; }
int git_branch_name_is_valid(int *valid, const char *name) { return 0; }
int git_tag_name_is_valid(int *valid, const char *name) { return 0; }

// #208 — host-native (non-Nix, non-wasm) portability check for the ChunkSource
// adapter added to `sourceToSink()` in patches/nix-2.34.7-wasm32-port.patch
// (src/libutil/serialise.cc).
//
// WHY THIS EXISTS: the wasm32 port of nix's sourceToSink() can't use upstream's
// boost stackful coroutine (no fcontext backend on wasm), so it buffers every
// pushed chunk and replays it through a Source at finish() instead. The first
// cut of that buffer was a single contiguous std::string (`buffer.append(in)`);
// because libc++'s basic_string grows by exact doubling, appending a ~128 MiB
// compressed NAR (e.g. guest-clang's download) eventually issues ONE allocation
// sized to the whole buffer so far — an order-16 buddy-block request the NOMMU
// guest routinely can't satisfy, throwing std::bad_alloc that nix then
// misreports as "no substituter that can build it". The fix keeps each pushed
// chunk as its own std::string in a std::deque (never relocated on push_back)
// and reads them back through ChunkSource, which walks the chunk list
// sequentially — so no single allocation on the download path exceeds one HTTP
// chunk (tens of KB).
//
// ChunkSource itself has no wasm-specific code and no nix-specific
// dependencies beyond the Source/EndOfFile shapes it's written against, so its
// logic — the actual bug class this file exists to catch (off-by-one at chunk
// boundaries, short reads, a read whose `len` spans or exceeds a chunk, empty/
// zero-length chunks) — can be verified with a plain host compiler. This file
// is NOT part of the cross build or any Nix derivation; it mirrors the real
// adapter byte-for-byte (see the comment above the class below) purely as a
// standalone regression/portability check, run by hand:
//
//   c++ -std=c++20 -O1 -Wall -Wextra -o /tmp/chunk-source-test spikes/nix208-chunk-source/chunk-source-test.cc
//   /tmp/chunk-source-test
//
// If this file and the ChunkSource in serialise.cc ever drift, re-sync them —
// this is a mirror, not a #include of the real one (the real one lives inside
// a patch file, not a compiled header, and depends on nix's actual Source /
// EndOfFile / fun<> types).

#include <cassert>
#include <cstdio>
#include <cstring>
#include <deque>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

// ---- Minimal stand-ins for the two nix types ChunkSource depends on. ----

struct EndOfFile : std::runtime_error
{
    explicit EndOfFile(const std::string & msg)
        : std::runtime_error(msg)
    {
    }
};

struct Source
{
    virtual ~Source() = default;

    // Same contract as nix's real nix::Source::read(): store up to `len`
    // bytes, return how many were actually stored (> 0), or throw EndOfFile
    // if nothing more is available. Never returns 0 without throwing.
    virtual size_t read(char * data, size_t len) = 0;
};

// ---- Byte-for-byte mirror of ChunkSource in
//      patches/nix-2.34.7-wasm32-port.patch (src/libutil/serialise.cc). ----

struct ChunkSource : Source
{
    std::deque<std::string> & chunks;
    size_t idx = 0;
    size_t pos = 0;

    explicit ChunkSource(std::deque<std::string> & chunks)
        : chunks(chunks)
    {
    }

    size_t read(char * data, size_t len) override
    {
        // Skip past exhausted chunks (this also skips zero-length ones
        // outright, since `pos == chunks[idx].size()` is `0 == 0`).
        while (idx < chunks.size() && pos == chunks[idx].size()) {
            idx++;
            pos = 0;
        }
        if (idx == chunks.size())
            throw EndOfFile("end of chunked buffer reached");
        size_t n = chunks[idx].copy(data, len, pos);
        pos += n;
        return n;
    }
};

// ---- Test harness ----

// Mirrors nix::Source::operator()(char*, len): the blocking form every real
// decompression reader actually calls, which loops read() until it has
// exactly `len` bytes or an exception propagates.
static void readExact(Source & src, char * data, size_t len)
{
    while (len) {
        size_t n = src.read(data, len);
        assert(n > 0 && n <= len && "read() must return >0 and <=len, or throw");
        data += n;
        len -= n;
    }
}

// Drains `src` to EOF using RANDOMIZED per-call read lengths (1..maxReadLen),
// exercising short reads, reads spanning/exceeding a chunk boundary, etc.
// Returns the concatenation of everything read.
template<class RNG>
static std::string drainRandom(Source & src, RNG & rng, size_t maxReadLen)
{
    std::string out;
    std::uniform_int_distribution<size_t> lenDist(1, maxReadLen);
    std::vector<char> buf(maxReadLen);
    for (;;) {
        size_t want = lenDist(rng);
        size_t n;
        try {
            n = src.read(buf.data(), want);
        } catch (EndOfFile &) {
            break;
        }
        assert(n > 0 && n <= want && "read() must return >0 and <=len, or throw");
        out.append(buf.data(), n);
    }
    return out;
}

static int failures = 0;

static void check(bool cond, const char * what)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

// One randomized trial: build `numChunks` chunks with sizes in
// [0, maxChunkLen] (deliberately including 0 often), read them back with
// random read sizes in [1, maxReadLen], and assert the result matches the
// exact concatenation.
template<class RNG>
static void fuzzTrial(RNG & rng, size_t numChunks, size_t maxChunkLen, size_t maxReadLen)
{
    std::deque<std::string> chunks;
    std::string expected;
    std::uniform_int_distribution<size_t> chunkLenDist(0, maxChunkLen);
    std::uniform_int_distribution<int> byteDist(0, 255);

    for (size_t i = 0; i < numChunks; i++) {
        size_t len = chunkLenDist(rng);
        std::string chunk;
        chunk.reserve(len);
        for (size_t j = 0; j < len; j++)
            chunk.push_back(static_cast<char>(byteDist(rng)));
        chunks.push_back(chunk);
        expected += chunk;
    }

    ChunkSource src(chunks);
    std::string actual = drainRandom(src, rng, maxReadLen);
    check(actual == expected, "fuzzTrial: drained bytes != concatenation");

    // Once exhausted, read() must keep throwing EndOfFile (not resurrect
    // data, not crash) — matches StringSource's behavior at end of buffer.
    char probe[8];
    bool threw = false;
    try {
        src.read(probe, sizeof probe);
    } catch (EndOfFile &) {
        threw = true;
    }
    check(threw, "fuzzTrial: read() past EOF did not throw EndOfFile");
}

int main()
{
    std::mt19937_64 rng(0xC0FFEE);

    // ---- Explicit edge cases named in the #208 verification brief ----

    // Empty input: no chunks pushed at all.
    {
        std::deque<std::string> chunks;
        ChunkSource src(chunks);
        char buf[16];
        bool threw = false;
        try {
            src.read(buf, sizeof buf);
        } catch (EndOfFile &) {
            threw = true;
        }
        check(threw, "empty input: read() must throw EndOfFile immediately");
    }

    // A single zero-length chunk only.
    {
        std::deque<std::string> chunks{""};
        ChunkSource src(chunks);
        char buf[16];
        bool threw = false;
        try {
            src.read(buf, sizeof buf);
        } catch (EndOfFile &) {
            threw = true;
        }
        check(threw, "single zero-length chunk: read() must throw EndOfFile");
    }

    // Zero-length chunks interspersed between real ones must be transparently
    // skipped, never surfacing as a spurious empty read or an EOF too early.
    {
        std::deque<std::string> chunks{"abc", "", "def", "", "", "ghi"};
        ChunkSource src(chunks);
        char buf[64];
        readExact(src, buf, 9);
        check(std::string(buf, 9) == "abcdefghi", "interspersed zero-length chunks: wrong bytes");
        bool threw = false;
        try {
            src.read(buf, 1);
        } catch (EndOfFile &) {
            threw = true;
        }
        check(threw, "interspersed zero-length chunks: must EOF after last real byte");
    }

    // 1-byte-at-a-time reads across a chunk boundary (the classic off-by-one
    // site: idx/pos bookkeeping at the exact moment a chunk is exhausted).
    {
        std::deque<std::string> chunks{"AB", "CD", "E"};
        ChunkSource src(chunks);
        std::string got;
        char c;
        for (int i = 0; i < 5; i++) {
            readExact(src, &c, 1);
            got.push_back(c);
        }
        check(got == "ABCDE", "1-byte reads across boundaries: wrong bytes");
        bool threw = false;
        try {
            src.read(&c, 1);
        } catch (EndOfFile &) {
            threw = true;
        }
        check(threw, "1-byte reads: must EOF exactly at the end, not before/after");
    }

    // A single read() call whose `len` exceeds the CURRENT chunk's remaining
    // bytes: must return only that chunk's remainder (partial fulfillment is
    // contractually fine — nix::Source::operator() loops), never silently
    // reading past the chunk into the next one within one read() call, and
    // never throwing just because len > what's left in this chunk.
    {
        std::deque<std::string> chunks{"hi", "world!"};
        ChunkSource src(chunks);
        char buf[64];
        size_t n = src.read(buf, 64); // way bigger than "hi" (2 bytes)
        check(n == 2 && std::string(buf, n) == "hi", "read() must not span a chunk boundary in one call");
        n = src.read(buf, 64); // now the whole second (and only remaining) chunk
        check(n == 6 && std::string(buf, n) == "world!", "read() of the final chunk returned wrong bytes");
        bool threw = false;
        try {
            src.read(buf, 1);
        } catch (EndOfFile &) {
            threw = true;
        }
        check(threw, "read() past both chunks must throw EndOfFile");
    }

    // A read spanning SEVERAL chunks via the blocking readExact() wrapper
    // (mirrors how nix's decompressors actually consume a Source in
    // practice: Source::operator()(data,len), not raw read()).
    {
        std::deque<std::string> chunks{"foo", "", "bar", "baz", "", "", "qux"};
        ChunkSource src(chunks);
        char buf[12];
        readExact(src, buf, 12);
        check(std::string(buf, 12) == "foobarbazqux", "readExact spanning many chunks: wrong bytes");
    }

    // Larger deliberately-adversarial chunk/read-size pairings: read size
    // exactly 1 less / equal to / 1 more than a chunk boundary sum.
    {
        std::deque<std::string> chunks{"0123456789", "abcdefghij"}; // 10 + 10 = 20
        std::string expected = "0123456789abcdefghij";
        for (size_t readLen : {1, 5, 9, 10, 11, 15, 19, 20, 21, 100}) {
            std::deque<std::string> localChunks = chunks;
            ChunkSource src(localChunks);
            std::string got;
            char buf[128];
            for (;;) {
                size_t n;
                try {
                    n = src.read(buf, readLen);
                } catch (EndOfFile &) {
                    break;
                }
                got.append(buf, n);
            }
            check(got == expected, "adversarial fixed read-length sweep produced wrong bytes");
        }
    }

    // ---- Randomized fuzzing across a range of shapes ----
    const int numTrials = 2000;
    for (int t = 0; t < numTrials; t++) {
        // Vary the shape: mostly-small chunks/reads early, occasional larger
        // ones, and a decent share of zero-length chunks (chunkLenDist's
        // lower bound is 0, so ~1/(maxChunkLen+1) of chunks are empty).
        size_t numChunks = 1 + (rng() % 12);
        size_t maxChunkLen = 1 + (rng() % 40);
        size_t maxReadLen = 1 + (rng() % 40);
        fuzzTrial(rng, numChunks, maxChunkLen, maxReadLen);
    }

    // A few large trials (closer in spirit to real HTTP-chunk/decompressor
    // traffic sizes, just scaled down for a fast test) with read sizes that
    // routinely straddle several chunks at once.
    for (int t = 0; t < 20; t++) {
        fuzzTrial(rng, /*numChunks=*/50, /*maxChunkLen=*/4096, /*maxReadLen=*/16384);
    }

    if (failures) {
        std::fprintf(stderr, "\n%d CHECK(S) FAILED\n", failures);
        return 1;
    }
    std::printf(
        "OK: explicit edge cases passed (empty input, single zero-length "
        "chunk, interspersed zero-length chunks, 1-byte boundary-straddling "
        "reads, len > remaining-chunk reads, multi-chunk-spanning readExact, "
        "adversarial fixed-length sweep) + %d small fuzz trials + 20 large "
        "fuzz trials, all bit-exact against the concatenation.\n",
        numTrials);
    return 0;
}

// #208 — host-native (non-Nix, non-wasm) portability check for the ChunkSource
// adapter shared by `sourceToSink()` and `sinkToSource()` in
// patches/nix-2.34.7-wasm32-port.patch (src/libutil/serialise.cc).
//
// WHY THIS EXISTS: the wasm32 port of nix's sourceToSink()/sinkToSource() can't
// use upstream's boost stackful coroutine (no fcontext backend on wasm), so
// both buffer everything pushed and replay it through a Source once fully
// collected. The first cut of BOTH buffers was a single contiguous std::string
// (`buffer.append(in)` / `StringSink::s`); because libc++'s basic_string grows
// by exact doubling, appending a large payload eventually issues ONE
// reallocation sized to the whole buffer so far — a high-order buddy-block
// request. For issue #208 (substituting `guest-clang`) that request was
// 134,352,896 B (order-16, needs a 256 MiB block), and it's `sinkToSource`'s
// buffer — the DECOMPRESSED NAR, ~100.9 MB for that package — that produced
// it, not `sourceToSink`'s compressed-download buffer (~23 MB, peaks around
// 32-34 MB): see the two functions' own comments in the real patch for the
// growth-simulation math that pins this down. Both got the identical fix
// regardless, since both scale with their respective payload size. The fix
// keeps each pushed chunk as its own std::string in a std::deque (never
// relocated on push_back) and reads them back through ChunkSource, which
// walks (and, as chunks are consumed, pop_front()s) the chunk list
// sequentially — so no single allocation on either path exceeds one pushed
// chunk.
//
// ChunkSource itself has no wasm-specific code and no nix-specific
// dependencies beyond the Source/Sink/EndOfFile shapes it's written against,
// so its logic — the actual bug class this file exists to catch (off-by-one
// at chunk boundaries, short reads, a read whose `len` spans or exceeds a
// chunk, empty/zero-length chunks, and — for the sourceToSink/sinkToSource
// wrappers below — first-call-only side effects and exhausted-Source EOF
// semantics) — can be verified with a plain host compiler. This file is NOT
// part of the cross build or any Nix derivation; it mirrors the real code
// byte-for-byte (see the comment above each mirrored piece) purely as a
// standalone regression/portability check, run by hand:
//
//   c++ -std=c++20 -O1 -Wall -Wextra -o /tmp/chunk-source-test spikes/nix208-chunk-source/chunk-source-test.cc
//   /tmp/chunk-source-test
//
// If this file and serialise.cc ever drift, re-sync them — this is a mirror,
// not a #include of the real one (the real one lives inside a patch file, not
// a compiled header, and depends on nix's actual Source/Sink/EndOfFile/fun<>
// types; here fun<Sig> is stood in for by std::function<Sig>, a faithful
// enough substitute for exercising the control flow — fun<Sig> is itself just
// a non-nullable wrapper around std::function, per src/libutil/include/nix/
// util/fun.hh).

#include <cassert>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

// ---- Minimal stand-ins for the nix types this file's mirrors depend on. ----

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

struct Sink
{
    virtual ~Sink() = default;
    virtual void operator()(std::string_view data) = 0;
};

struct FinishSink : virtual Sink
{
    virtual void finish() = 0;
};

struct LambdaSink : Sink
{
    using data_t = std::function<void(std::string_view)>;
    data_t dataFun;

    explicit LambdaSink(data_t dataFun)
        : dataFun(std::move(dataFun))
    {
    }

    void operator()(std::string_view data) override
    {
        dataFun(data);
    }
};

[[noreturn]] static void unreachable()
{
    std::abort();
}

// ---- Byte-for-byte mirror of ChunkSource in
//      patches/nix-2.34.7-wasm32-port.patch (src/libutil/serialise.cc). ----

struct ChunkSource : Source
{
    std::deque<std::string> & chunks;
    size_t pos = 0;

    explicit ChunkSource(std::deque<std::string> & chunks)
        : chunks(chunks)
    {
    }

    size_t read(char * data, size_t len) override
    {
        // Drop each chunk once fully consumed (rather than merely stepping
        // an index past it) so its memory is freed as we go. This also
        // skips zero-length chunks outright, since `pos ==
        // chunks.front().size()` is `0 == 0` for one.
        while (!chunks.empty() && pos == chunks.front().size()) {
            chunks.pop_front();
            pos = 0;
        }
        if (chunks.empty())
            throw EndOfFile("end of chunked buffer reached");
        size_t n = chunks.front().copy(data, len, pos);
        pos += n;
        return n;
    }
};

// ---- Byte-for-byte mirror of sourceToSink()/sinkToSource() themselves
//      (patches/nix-2.34.7-wasm32-port.patch, src/libutil/serialise.cc) —
//      exercises the wrapper plumbing (first-call-only side effects, EOF
//      dispatch to a caller-supplied `eof()`), not just ChunkSource in
//      isolation. ----

static std::unique_ptr<FinishSink> sourceToSink(std::function<void(Source &)> reader)
{
    struct SourceToSink : FinishSink
    {
        std::function<void(Source &)> reader;
        std::deque<std::string> chunks;

        explicit SourceToSink(std::function<void(Source &)> reader)
            : reader(std::move(reader))
        {
        }

        void operator()(std::string_view in) override
        {
            if (in.empty())
                return;
            chunks.emplace_back(in);
        }

        void finish() override
        {
            ChunkSource source(chunks);
            reader(source);
        }
    };

    return std::make_unique<SourceToSink>(std::move(reader));
}

static std::unique_ptr<Source> sinkToSource(std::function<void(Sink &)> writer, std::function<void()> eof)
{
    struct SinkToSource : Source
    {
        std::function<void(Sink &)> writer;
        std::function<void()> eof;
        std::deque<std::string> chunks;
        std::unique_ptr<ChunkSource> chunkSource;

        SinkToSource(std::function<void(Sink &)> writer, std::function<void()> eof)
            : writer(std::move(writer))
            , eof(std::move(eof))
        {
        }

        size_t read(char * data, size_t len) override
        {
            if (!chunkSource) {
                LambdaSink sink([&](std::string_view data) {
                    if (!data.empty())
                        chunks.emplace_back(data);
                });
                writer(sink);
                chunkSource = std::make_unique<ChunkSource>(chunks);
            }

            try {
                return chunkSource->read(data, len);
            } catch (EndOfFile &) {
                eof();
                unreachable();
            }
        }
    };

    return std::make_unique<SinkToSource>(std::move(writer), std::move(eof));
}

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

    // ==== sourceToSink() / sinkToSource() wrapper tests (the actual #208
    //      site is inside sinkToSource — see the header comment) ====

    // sourceToSink: push several chunks, then finish() with a reader that
    // reads everything back via the blocking form. Exercises the real
    // operator()/finish() plumbing, not just ChunkSource standalone.
    {
        auto sink = sourceToSink([](Source & source) {
            char buf[64];
            readExact(source, buf, 11);
            check(std::string(buf, 11) == "hello world", "sourceToSink: reader got wrong bytes");
            bool threw = false;
            try {
                source.read(buf, 1);
            } catch (EndOfFile &) {
                threw = true;
            }
            check(threw, "sourceToSink: reader must see EOF after the pushed bytes");
        });
        (*sink)("hello ");
        (*sink)("world");
        (*sink)(""); // empty pushes must be silently ignored, mirroring upstream
        sink->finish();
    }

    // sourceToSink: finish() with nothing ever pushed — reader must see EOF
    // immediately, not crash or hang.
    {
        bool reached = false;
        auto sink = sourceToSink([&](Source & source) {
            reached = true;
            char buf[8];
            bool threw = false;
            try {
                source.read(buf, 1);
            } catch (EndOfFile &) {
                threw = true;
            }
            check(threw, "sourceToSink: empty push history must EOF immediately");
        });
        sink->finish();
        check(reached, "sourceToSink: reader must still run on an empty push history");
    }

    // sinkToSource: `writer` pushes chunks (including some empty ones, which
    // must be filtered exactly like sourceToSink's operator() does); drive
    // the returned Source to EOF via a custom `eof` callback (mirrors real
    // call sites like copyStorePath's, which throw a specific error type —
    // not necessarily EndOfFile) and check the drained bytes plus that
    // `writer` ran exactly once no matter how many read() calls it took.
    {
        struct DoneMarker : std::exception
        {
        };

        int writerCalls = 0;
        auto source = sinkToSource(
            [&](Sink & sink) {
                writerCalls++;
                sink("foo");
                sink("");
                sink("bar");
                sink("");
                sink("");
                sink("baz");
            },
            [] { throw DoneMarker{}; });

        std::string got;
        char buf[2]; // deliberately tiny to force many short reads
        bool sawDone = false;
        for (;;) {
            try {
                size_t n = source->read(buf, sizeof buf);
                got.append(buf, n);
            } catch (DoneMarker &) {
                sawDone = true;
                break;
            }
        }
        check(got == "foobarbaz", "sinkToSource: drained bytes != what writer pushed (minus empties)");
        check(sawDone, "sinkToSource: caller's eof() must be the thing that ends the read loop");
        check(writerCalls == 1, "sinkToSource: writer must run exactly once regardless of read() call count");

        // Reading again past EOF must keep invoking the custom eof(), not
        // resurrect data or silently return 0.
        bool sawDoneAgain = false;
        try {
            source->read(buf, 1);
        } catch (DoneMarker &) {
            sawDoneAgain = true;
        }
        check(sawDoneAgain, "sinkToSource: read() past EOF must keep calling eof(), not go quiet");
    }

    // sinkToSource: writer pushes nothing at all — first read() must hit
    // eof() immediately (mirrors StringSink's `pos(0) >= buffer.size()(0)`
    // pre-fix behavior).
    {
        bool eofCalled = false;
        auto source = sinkToSource([](Sink &) { /* pushes nothing */ }, [&] {
            eofCalled = true;
            throw EndOfFile("nothing was ever pushed");
        });
        char buf[8];
        bool threw = false;
        try {
            source->read(buf, sizeof buf);
        } catch (EndOfFile &) {
            threw = true;
        }
        check(threw && eofCalled, "sinkToSource: empty writer must EOF on the very first read()");
    }

    // sinkToSource: randomized fuzzing through the FULL wrapper (writer
    // pushes randomly-sized chunks, including empties; reads are
    // randomly-sized too), the sinkToSource counterpart of fuzzTrial above.
    for (int t = 0; t < 500; t++) {
        std::uniform_int_distribution<size_t> numChunksDist(0, 15);
        std::uniform_int_distribution<size_t> chunkLenDist(0, 50);
        std::uniform_int_distribution<size_t> readLenDist(1, 50);
        std::uniform_int_distribution<int> byteDist(0, 255);

        size_t numChunks = numChunksDist(rng);
        std::vector<std::string> pieces;
        std::string expected;
        for (size_t i = 0; i < numChunks; i++) {
            size_t len = chunkLenDist(rng);
            std::string piece;
            for (size_t j = 0; j < len; j++)
                piece.push_back(static_cast<char>(byteDist(rng)));
            pieces.push_back(piece);
            expected += piece;
        }

        auto src = sinkToSource(
            [&](Sink & sink) {
                for (auto & p : pieces)
                    sink(p);
            },
            [] { throw EndOfFile("fuzz sentinel"); });

        std::string got;
        std::vector<char> buf(readLenDist(rng)); // fixed per-trial, still varies trial-to-trial
        for (;;) {
            size_t want = readLenDist(rng);
            if (buf.size() < want)
                buf.resize(want);
            size_t n;
            try {
                n = src->read(buf.data(), want);
            } catch (EndOfFile &) {
                break;
            }
            check(n > 0 && n <= want, "sinkToSource fuzz: read() violated the >0,<=len contract");
            got.append(buf.data(), n);
        }
        check(got == expected, "sinkToSource fuzz: drained bytes != concatenation of non-empty pushes");
    }

    if (failures) {
        std::fprintf(stderr, "\n%d CHECK(S) FAILED\n", failures);
        return 1;
    }
    std::printf(
        "OK: ChunkSource edge cases (empty input, single zero-length chunk, "
        "interspersed zero-length chunks, 1-byte boundary-straddling reads, "
        "len > remaining-chunk reads, multi-chunk-spanning readExact, "
        "adversarial fixed-length sweep) + %d small + 20 large ChunkSource "
        "fuzz trials + sourceToSink()/sinkToSource() wrapper tests (push/"
        "finish plumbing, empty-history EOF, custom eof() dispatch, "
        "writer-runs-exactly-once, empty writer, 500 sinkToSource fuzz "
        "trials), all bit-exact against the concatenation.\n",
        numTrials);
    return 0;
}

// Clover's tests for its change to the caching handler (native/mounts/third_party/README.md).
package helpers

import (
	"fmt"
	"testing"
	"time"

	"github.com/go-git/go-billy/v5/memfs"
)

// FromHandle's cost must not grow with the number of live handles: every NFS call starts with it.
func TestFromHandleCostIsFlat(t *testing.T) {
	per := func(n int) time.Duration {
		fs := memfs.New()
		h := NewCachingHandler(NewNullAuthHandler(fs), 1<<20)
		hs := make([][]byte, n)
		for i := 0; i < n; i++ {
			hs[i] = h.ToHandle(fs, []string{"packages", fmt.Sprintf("p%d", i%40), "src", fmt.Sprintf("f%d.ts", i)})
		}
		const calls = 20000
		start := time.Now()
		for i := 0; i < calls; i++ {
			if _, _, err := h.FromHandle(hs[i%n]); err != nil {
				t.Fatal(err)
			}
		}
		return time.Since(start) / calls
	}
	small, large := per(100), per(100000)
	t.Logf("FromHandle: %v with 100 handles live, %v with 100,000", small, large)
	if large > 20*small+20*time.Microsecond {
		t.Fatalf("FromHandle grew with the live handles: %v → %v", small, large)
	}
}

// A folder used through what is inside it must outlive handles nobody uses, as upstream meant.
func TestFromHandleKeepsAncestorsRecent(t *testing.T) {
	fs := memfs.New()
	h := NewCachingHandler(NewNullAuthHandler(fs), 8).(*CachingHandler)
	dir := h.ToHandle(fs, []string{"a"})
	sub := h.ToHandle(fs, []string{"a", "b"})
	leaf := h.ToHandle(fs, []string{"a", "b", "c.txt"})
	for i := 0; i < 20; i++ {
		_ = h.ToHandle(fs, []string{fmt.Sprintf("other%d", i)})
		if _, _, err := h.FromHandle(leaf); err != nil {
			t.Fatalf("leaf evicted after %d other handles: %v", i, err)
		}
	}
	for name, hd := range map[string][]byte{"a": dir, "a/b": sub} {
		if _, _, err := h.FromHandle(hd); err != nil {
			t.Fatalf("ancestor %s was evicted though its child stayed in use: %v", name, err)
		}
	}
}

func BenchmarkFromHandle(b *testing.B) {
	for _, n := range []int{100, 4000, 12000, 100000} {
		b.Run(fmt.Sprintf("handles=%d", n), func(b *testing.B) {
			fs := memfs.New()
			h := NewCachingHandler(NewNullAuthHandler(fs), 1<<20)
			hs := make([][]byte, n)
			for i := 0; i < n; i++ {
				hs[i] = h.ToHandle(fs, []string{"packages", fmt.Sprintf("p%d", i%40), "src", fmt.Sprintf("f%d.ts", i)})
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, _, err := h.FromHandle(hs[i%n]); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

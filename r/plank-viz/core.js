// Shared by the landing page and presentation.
// Extracted by tools/import-plank-presentation.py; original licenses follow.
/*! Bireactive 0.3.5 — Orion Reed
MIT License

Copyright (c) 2026 Orion Reed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(function(global){
"use strict";
// Counts-first instrumentation: judge engine work by discrete event *counts*
// (callbacks invoked, codepaths entered, nodes visited, edges spliced), not
// timings, so a minimal engine has a calculable target. Off by default — each
// site reads `if (COUNTS) counts.x++`, so a minifier drops it when off and it
// costs one branch when on. Flip via `withCounts`.
function fresh() {
    return {
        recompute: 0,
        propagate: 0,
        checkDirty: 0,
        link: 0,
        unlink: 0,
        arm: 0,
        armBlocked: 0,
        markDownVisit: 0,
        linkChild: 0,
        unlinkChild: 0,
        resolveConeVisit: 0,
        writeBackVisit: 0,
        reassertScan: 0,
        put: 0,
        fold: 0,
    };
}
/** Live counter record. Mutated in place so importers hold a stable reference. */
const counts = fresh();
/** The single gate. Read at every instrumented site; flip via `withCounts`. */
let COUNTS = false;
/** Reset all counters to zero (keeps the same object identity). */
function resetCounts() {
    Object.assign(counts, fresh());
}
/** Shallow copy of the current counts. */
function snapshotCounts() {
    return { ...counts };
}
/** Run `fn` with counting on from a zero baseline; returns the result and the
 *  counts it accrued. Restores the prior gate state (counters left as measured). */
function withCounts(fn) {
    const prevOn = COUNTS;
    resetCounts();
    COUNTS = true;
    try {
        const result = fn();
        return { result, counts: snapshotCounts() };
    }
    finally {
        COUNTS = prevOn;
    }
}

// cell.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim. Backward is the same lazy
// push-pull on the transpose of the lens graph, carried by `LensLink` (the dual
// of `Link`): `parentEdges` down, `childEdges` up. A view write marks the
// back-path `BF.Pending` and wakes each source's cone; nothing runs until a read
// pulls. Reads pull only at clean entry points (getter top, source
// `_update`/`_writeSource`, effect `_run`), never mid-compute.
//
//   role            forward (source → view)      backward (view → source)
//   down edge       subs (who reads me)          parentEdges (my parents)
//   up edge         deps (my deps)               childEdges (my lens-children)
//   push (mark)     propagate (down `subs`)      markDown (down `parentEdges`)
//   pull (resolve)  checkDirty (up `deps`)       resolveCone (up `childEdges`)
//   commit/compute  _update / getter             writeBack
//   "dirty" flag    F.Dirty (source staged)      BF.Dirty (view holds target)
//   "pending" flag  F.Pending (on the cone)      BF.Pending (on the back-path)
//
// Forward flags live on `flags`, backward on a separate `bflags` word. Fan-in is
// the one non-dual piece: a `merge` folds N contributors once, post-order, in
// `resolveCone`. A cell's mode is read off `getter`/`_bwd` field presence:
//   source      getter undefined                       (truth in currentValue)
//   derived    getter, no _bwd                         (read-only derived)
//   lens 1→1    getter + _bwd{ put }                    (scalar put)
//   multi-out   getter + _bwd{ put, scatter }           (1→N / N→M tuple put)
//   merge       getter + _bwd{ merge }                  (N→1 backward fold)
//   stateful    getter + _bwd{ put, scatter, stateful } (complement-carrying)
//   pin         getter + _bwd{} no parentEdges          (parentless sink)
// Writable iff `_bwd !== undefined`. `pendingValue` is a source's staged write
// (and a view's armed back-target); a derived cell never uses it forward.
// Counts-first instrumentation: off by default, one branch per site (see _counts).

// ─────────────────────────────────────────────────────────────────────────
// Module state — mutable engine-wide variables and pooled scratch buffers.
// Every pool is non-reentrant: forward and backward runs never nest, so one
// shared buffer per role suffices (no per-call allocation).
// ─────────────────────────────────────────────────────────────────────────
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub;
let flushing = false;
/** A microtask flush is queued. Effects run asynchronously (end of turn), so a
 *  burst of writes wakes each at most once; reads stay synchronous. */
let scheduled = false;
/** A `Sync` watcher (a `network`) is queued: a wake flushes the whole queue
 *  synchronously (eager solve), so a read right after the write sees post-solve
 *  state. Writes that wake plain effects alone defer to the microtask. */
let syncFlush = false;
/** The running self-excluding watcher (`Exclude`-mode `Effect`), passed as
 *  `propagate`'s `excluding` so its own writes don't re-trigger it. */
let activeExcluded;
const queued = [];
/** Re-entrancy guard: during a back-resolve a `put`'s source read commits
 *  normally but must NOT trigger a nested resolve. */
let draining = false;
// Pooled backward-traversal buffers (non-reentrant under `draining`, so reused
// across calls — no per-call allocation).
/** `backResolve` phase-1 source worklist (collect, then resolve in phase 2). */
const backSources = [];
/** Monotone epoch stamped onto `Cell.bEpoch` during a `backResolve` collect, so
 *  diamonds visit each node once without a Set (the backward dual of `cycle`). */
let backCycle = 0;
/** `writeBack`'s explicit descent stack (depth-first, left-to-right), as two
 *  parallel pooled columns. Non-reentrant — a `writeBack` triggers no nested
 *  `writeBack` — so one shared stack suffices (no per-call allocation). */
const wbNode = [];
const wbTarget = [];
/** `resolveCone`'s pooled post-order frame stack: the node and its next-child
 *  cursor. Non-reentrant (no nested `resolveCone`), so shared pools suffice. */
const rcNode = [];
const rcEdge = [];
const EMPTY_DIRTY = new Set();
/** Fires on every source value-change. Backward writes reach it via `_writeSource`. */
let writeHook;
// ─────────────────────────────────────────────────────────────────────────
// Internal constants & types — flag bits, mode bits, and the node/edge records.
// ─────────────────────────────────────────────────────────────────────────
// Forward flag bits (alien-signals v2), on `flags`.
const F = {
    None: 0,
    Mutable: 1,
    Watching: 2,
    RecursedCheck: 4,
    Recursed: 8,
    Dirty: 16,
    Pending: 32,
};
// Backward flag bits, on a Cell's own `bflags` word (the dual of `flags`).
const BF = {
    None: 0,
    /** Dual of `F.Dirty`: this view holds an unresolved back-target in `pendingValue`. */
    Dirty: 1,
    /** Dual of `F.Pending`: this node is on the back-path to its sources. */
    Pending: 2,
    /** Static (set once at construction): a write armed here is structurally
     *  impossible — its mandatory back-spine dead-ends at a sole read-only-derived
     *  parent. Checked atop `arm` so the throw lands before any backward mutation. */
    WriteBlocked: 4,
};
/** Armed root OR on a back-path — i.e. a read must `backResolve` first. */
const BACK_MARKED = BF.Dirty | BF.Pending;
// Effect mode bits (on `Effect.mode`), so one watcher class serves both plain
// effects (`None`) and `network()` (which sets these).
const EM = {
    None: 0,
    /** Explicit topology: body reads don't auto-subscribe (no re-link / purge). */
    NoTrack: 1,
    /** Self-exclude the node's own writes (set `activeExcluded` during the body). */
    Exclude: 2,
    /** A wake forces a synchronous flush (eager solve), vs the microtask default. */
    Sync: 4,
    /** Don't auto-fire on a wake; only an explicit `flush()` advances the body. */
    Manual: 8,
};
// ─────────────────────────────────────────────────────────────────────────
// Internal helpers — mode predicates, edge wiring, and the write-hook installer.
// ─────────────────────────────────────────────────────────────────────────
// Mode predicates — the single place a cell's role is read off its fields.
/** Source (truth leaf): no forward derivation. */
function isSource(c) {
    return c.getter === undefined;
}
/** Writable: carries a backward sidecar (lens / multi-out / merge / stateful / pin). */
function isWritable(c) {
    return c._bwd !== undefined;
}
/** Read-only derived: a `derive` with no backward path (back-walk throws on it). */
function isReadOnlyDerived(c) {
    return !isSource(c) && !isWritable(c);
}
/** Value a source-reading `put` linearizes at, with no cascading recompute:
 *  the live/last-settled value, realizing once via `.value` if never computed. */
function backPrimal(c) {
    if (c.getter === undefined || c.flags & F.Dirty)
        return c.value;
    return c.currentValue;
}
/** Create a lens-edge `child →[index] parent`, appended to `child.parentEdges`
 *  in tuple order. */
function linkLens(child, parent, index) {
    const e = {
        index,
        parent,
        child,
        linked: false,
        nextParent: undefined,
        prevChild: undefined,
        nextChild: undefined,
    };
    if (child.parentEdgesTail !== undefined)
        child.parentEdgesTail.nextParent = e;
    else
        child.parentEdges = e;
    child.parentEdgesTail = e;
}
/** Splice a lens-edge into its parent's `childEdges` up-list, once. Idempotent via `linked`. */
function linkChild(e) {
    if (e.linked)
        return;
    if (COUNTS)
        counts.linkChild++;
    e.linked = true;
    const parent = e.parent;
    e.prevChild = parent.childEdgesTail;
    if (parent.childEdgesTail !== undefined)
        parent.childEdgesTail.nextChild = e;
    else
        parent.childEdges = e;
    parent.childEdgesTail = e;
}
/** Remove a lens-edge from its parent's `childEdges` up-list in O(1) and mark it
 *  re-linkable. Called on unwatch to release the parent→child retaining edge. */
function unlinkChild(e) {
    if (COUNTS)
        counts.unlinkChild++;
    const { parent, prevChild, nextChild } = e;
    if (nextChild !== undefined)
        nextChild.prevChild = prevChild;
    else
        parent.childEdgesTail = prevChild;
    if (prevChild !== undefined)
        prevChild.nextChild = nextChild;
    else
        parent.childEdges = nextChild;
    e.linked = false;
    e.prevChild = undefined;
    e.nextChild = undefined;
}
/** Precompute `BF.WriteBlocked` once, after a writable's `parentEdges` are linked.
 *  Mirrors `markDown`'s descent: a sole read-only-derived parent dead-ends (block);
 *  a split routes around a read-only parent; otherwise inherit the block from any
 *  non-read-only parent already flagged. */
function setWriteBlocked(cell) {
    const pe = cell.parentEdges;
    if (pe === undefined)
        return; // parentless sink (pin): absorbs, never dead-ends
    const sole = pe.nextParent === undefined;
    for (let e = pe; e !== undefined; e = e.nextParent) {
        const p = e.parent;
        if (isReadOnlyDerived(p)) {
            if (sole) {
                cell.bflags |= BF.WriteBlocked; // markDown would throw at this dead-end
                return;
            }
        }
        else if (p.bflags & BF.WriteBlocked) {
            cell.bflags |= BF.WriteBlocked; // a descended parent dead-ends deeper
            return;
        }
    }
}
/** Install a hook fired on every source value-change; returns a restore fn. */
function setCellWriteHook(fn) {
    const prev = writeHook;
    writeHook = fn;
    return () => {
        writeHook = prev;
    };
}
// ─────────────────────────────────────────────────────────────────────────
// Forward graph engine (internal) — alien-signals verbatim.
// ─────────────────────────────────────────────────────────────────────────
// alien-signals algorithm (verbatim): link / unlink / propagate / checkDirty.
function link(dep, sub, version) {
    const prevDep = sub.depsTail;
    if (prevDep !== undefined && prevDep.dep === dep)
        return;
    const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
    if (nextDep !== undefined && nextDep.dep === dep) {
        nextDep.version = version;
        sub.depsTail = nextDep;
        return;
    }
    const prevSub = dep.subsTail;
    if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub)
        return;
    if (COUNTS)
        counts.link++;
    const isFirstSub = dep.subs === undefined;
    const newLink = (sub.depsTail =
        dep.subsTail =
            {
                version,
                dep,
                sub,
                prevDep,
                nextDep,
                prevSub,
                nextSub: undefined,
            });
    if (nextDep !== undefined)
        nextDep.prevDep = newLink;
    if (prevDep !== undefined)
        prevDep.nextDep = newLink;
    else
        sub.deps = newLink;
    if (prevSub !== undefined)
        prevSub.nextSub = newLink;
    else
        dep.subs = newLink;
    // First-subscriber lifecycle hook (dual: last-sub in `_unwatched`).
    if (isFirstSub && dep instanceof Cell) {
        const hook = dep._watched;
        if (hook !== undefined)
            hook.call(dep);
    }
}
function unlink(l, sub = l.sub) {
    if (COUNTS)
        counts.unlink++;
    const { dep, prevDep, nextDep, nextSub, prevSub } = l;
    if (nextDep !== undefined)
        nextDep.prevDep = prevDep;
    else
        sub.depsTail = prevDep;
    if (prevDep !== undefined)
        prevDep.nextDep = nextDep;
    else
        sub.deps = nextDep;
    if (nextSub !== undefined)
        nextSub.prevSub = prevSub;
    else
        dep.subsTail = prevSub;
    if (prevSub !== undefined)
        prevSub.nextSub = nextSub;
    else if ((dep.subs = nextSub) === undefined)
        dep._unwatched();
    return nextDep;
}
function propagate(start, innerWrite, excluding) {
    if (COUNTS)
        counts.propagate++;
    let l = start;
    let next = start.nextSub;
    let stack;
    top: do {
        const sub = l.sub;
        // `excluding` skips one subscriber (a `network` not re-triggering itself).
        if (sub !== excluding) {
            let flags = sub.flags;
            if (!(flags & (F.RecursedCheck | F.Recursed | F.Dirty | F.Pending))) {
                sub.flags = flags | F.Pending;
                if (innerWrite)
                    sub.flags |= F.Recursed;
            }
            else if (!(flags & (F.RecursedCheck | F.Recursed))) {
                flags = F.None;
            }
            else if (!(flags & F.RecursedCheck)) {
                sub.flags = (flags & ~F.Recursed) | F.Pending;
            }
            else if (!(flags & (F.Dirty | F.Pending)) && isValidLink(l, sub)) {
                sub.flags = flags | (F.Recursed | F.Pending);
                flags &= F.Mutable;
            }
            else {
                flags = F.None;
            }
            if (flags & F.Watching)
                sub._notify();
            if (flags & F.Mutable) {
                const subSubs = sub.subs;
                if (subSubs !== undefined) {
                    const nextSub = (l = subSubs).nextSub;
                    if (nextSub !== undefined) {
                        stack = { value: next, prev: stack };
                        next = nextSub;
                    }
                    continue;
                }
            }
        }
        if ((l = next) !== undefined) {
            next = l.nextSub;
            continue;
        }
        while (stack !== undefined) {
            l = stack.value;
            stack = stack.prev;
            if (l !== undefined) {
                next = l.nextSub;
                continue top;
            }
        }
        break;
    } while (true);
}
function checkDirty(startLink, startSub) {
    if (COUNTS)
        counts.checkDirty++;
    let l = startLink, sub = startSub;
    let stack;
    let checkDepth = 0, dirty = false;
    top: do {
        const dep = l.dep;
        const flags = dep.flags;
        if (sub.flags & F.Dirty)
            dirty = true;
        else if ((flags & (F.Mutable | F.Dirty)) === (F.Mutable | F.Dirty) ||
            // A back-`Pending` source looks unchanged until `_update` resolves it
            // (pulls its views, runs the `put`s, stages it) and reports if it moved —
            // like a `Dirty` source. That resolve can re-mark nodes on this pull's
            // stack; the unwind below honors any such `F.Dirty`.
            (flags & F.Mutable &&
                dep.bflags & BF.Pending &&
                isSource(dep))) {
            const subs = dep.subs;
            if (dep._update()) {
                if (subs.nextSub !== undefined)
                    shallowPropagate(subs);
                dirty = true;
            }
        }
        else if ((flags & (F.Mutable | F.Pending)) === (F.Mutable | F.Pending)) {
            stack = { value: l, prev: stack };
            l = dep.deps;
            sub = dep;
            ++checkDepth;
            continue;
        }
        if (!dirty) {
            const nextDep = l.nextDep;
            if (nextDep !== undefined) {
                l = nextDep;
                continue;
            }
        }
        while (checkDepth--) {
            l = stack.value;
            stack = stack.prev;
            // `dirty` tracks change down this branch, but a node may have been marked
            // `F.Dirty` independently (a stateful stash `writeBack` mid-pull) — honor
            // that too, else we'd clear its `F.Pending` without recomputing.
            if (dirty || sub.flags & F.Dirty) {
                const subs = sub.subs;
                if (sub._update()) {
                    if (subs.nextSub !== undefined)
                        shallowPropagate(subs);
                    dirty = true;
                    sub = l.sub;
                    continue;
                }
                dirty = false;
            }
            else {
                sub.flags &= ~F.Pending;
            }
            sub = l.sub;
            const nextDep = l.nextDep;
            if (nextDep !== undefined) {
                l = nextDep;
                continue top;
            }
        }
        return dirty && !!sub.flags;
    } while (true);
}
function shallowPropagate(l) {
    do {
        const sub = l.sub;
        const flags = sub.flags;
        if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
            sub.flags = flags | F.Dirty;
            if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching)
                sub._notify();
        }
    } while ((l = l.nextSub) !== undefined);
}
function isValidLink(checkLink, sub) {
    let l = sub.depsTail;
    while (l !== undefined) {
        if (l === checkLink)
            return true;
        l = l.prevDep;
    }
    return false;
}
function purgeDeps(sub) {
    const depsTail = sub.depsTail;
    let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
    while (dep !== undefined)
        dep = unlink(dep, sub);
}
function disposeAllDepsInReverse(sub) {
    let l = sub.depsTail;
    while (l !== undefined) {
        const prev = l.prevDep;
        unlink(l, sub);
        l = prev;
    }
}
class MergeNode {
    foldFn;
    /** Contributions gathered as the cone resolves; folded and cleared in `foldMerge`. */
    contributions = [];
    constructor(fold) {
        this.foldFn = fold;
    }
}
// BwdSpec — the backward sidecar, off a single `_bwd` pointer (writable iff
// `_bwd !== undefined`). The backward shape is read off field presence, not a tag:
// `merge` ⇒ fan-in fold; `stateful` ⇒ complement-carrying; no `parentEdges` ⇒ pin
// sink; `scatter` ⇒ tuple `put` (the one bit not recoverable from topology, since a
// 1-parent split still takes a tuple).
class BwdSpec {
    /** Lens `put` (dual of `getter`): `put(target)` for 1→1 / multi-out,
     *  `put(target, sources, c)` for stateful. `undefined` for a merge or pin. */
    // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
    put = undefined;
    /** Fold payload; present ⇒ a fan-in merge. */
    merge = undefined;
    /** The mutable complement object a stateful optic's `get`/`put` thread (and may
     *  mutate in place); present ⇒ a complement-carrying (stateful) lens. Seeded once
     *  per bind from `optic.complement`, never reassigned. */
    stateful = undefined;
    /** `put` yields a per-parent tuple (split / stateful) vs a scalar (1→1). The
     *  only discriminant not derivable from topology (a 1-parent split is a tuple). */
    scatter = false;
}
// ─────────────────────────────────────────────────────────────────────────
// Public API — sentinels, read/write shapes, and value-coercion helpers.
// ─────────────────────────────────────────────────────────────────────────
/** Multi-out / stateful back-write sentinel: "leave this parent untouched."
 *  Every non-`SKIP` slot is written verbatim, `undefined` included; a short array
 *  skips the trailing parents. (1→1 `put` always writes its one parent.) */
const SKIP = Symbol("bireactive.SKIP");
/** Snapshot a `Val<T>` to plain `T` (one-shot, no tracking). */
function readNow(v) {
    if (v instanceof Cell)
        return v.value;
    return v;
}
/** Resolve a `Val<T>` to a `() => T` closure that unwraps on each call. */
function reader(v) {
    if (v instanceof Cell)
        return () => v.value;
    return () => v;
}
/** Lazy getter: computes once, installs a non-enumerable own prop under
 *  `key` that shadows this getter on later reads. */
function lazy(self, key, make) {
    const v = make();
    Object.defineProperty(self, key, {
        value: v,
        writable: false,
        configurable: false,
        enumerable: false,
    });
    return v;
}
const isCell = (v) => v instanceof Cell;
/** Lens mode: a derived cell that can be written back (has a backward sidecar). */
const isLens = (v) => v instanceof Cell && v.getter !== undefined && v._bwd !== undefined;
/** Read-only mode: derived with no backward path. */
const isReadonly = (v) => v instanceof Cell && v.getter !== undefined && v._bwd === undefined;
// ─────────────────────────────────────────────────────────────────────────
// Public API — the Cell class (the one user-facing reactive primitive).
// ─────────────────────────────────────────────────────────────────────────
class Cell {
    /** @internal */
    flags;
    /** @internal */
    subs;
    /** @internal */
    subsTail;
    /** @internal */
    deps;
    /** @internal */
    depsTail;
    /** @internal Forward derivation (computed/lens/merge). `undefined` ⇒ source. */
    getter;
    /** @internal Per-instance equality; always defined (defaults to `Object.is`). */
    _equals;
    /** @internal First-subscriber / last-subscriber lifecycle hooks. */
    _watched;
    /** @internal */
    _unwatchedHook;
    /** @internal Source: committed value + staged write. */
    currentValue;
    /** @internal */
    pendingValue;
    /** @internal Backward sidecar; `undefined` iff read-only. Writability is `_bwd !== undefined`. */
    _bwd;
    /** @internal Lens-edges to my back-targets (down); dual of `deps`. `markDown`/
     *  `backResolve` descend this toward sources. Index-ordered. */
    parentEdges;
    /** @internal */
    parentEdgesTail;
    /** @internal Lens-edges to my lens-children (up); dual of `subs`. `resolveCone`
     *  ascends this toward the armed views. */
    childEdges;
    /** @internal */
    childEdgesTail;
    /** @internal Backward flag word (`BF`), dual of forward `flags`. */
    bflags;
    /** @internal Visit epoch for `backResolve`'s collect phase (dedups diamonds
     *  without a Set; compared against the global `backCycle`). */
    bEpoch;
    /** Optional debug label (`cell(0, { name })`); used by errors and graph dumps. */
    name;
    // Every slot assigned once, in declaration order, for a stable V8 hidden class.
    constructor(initial, opts) {
        this.flags = F.Mutable;
        this.subs = undefined;
        this.subsTail = undefined;
        this.deps = undefined;
        this.depsTail = undefined;
        this.getter = undefined;
        this._equals = Object.is;
        this._watched = undefined;
        this._unwatchedHook = undefined;
        this.currentValue = initial;
        this.pendingValue = initial;
        this._bwd = undefined;
        this.parentEdges = undefined;
        this.parentEdgesTail = undefined;
        this.childEdges = undefined;
        this.childEdgesTail = undefined;
        this.bflags = BF.None;
        this.bEpoch = 0;
        this.name = undefined;
        if (opts !== undefined) {
            if (opts.equals !== undefined)
                this._equals = opts.equals;
            if (opts.watched !== undefined)
                this._watched = opts.watched;
            if (opts.unwatched !== undefined)
                this._unwatchedHook = opts.unwatched;
            if (opts.name !== undefined)
                this.name = opts.name;
        }
    }
    /** @internal Single write-commit point; self-excludes the active network. */
    _writeSource(next) {
        // Resolve any pending back-write first, so the later forward write wins (LWW).
        if (this.bflags & BF.Pending && !draining)
            backResolve(this);
        const prev = this.pendingValue;
        this.pendingValue = next;
        if (!this._equals(prev, next)) {
            this.flags = F.Mutable | F.Dirty;
            if (writeHook !== undefined)
                writeHook(this);
            const subs = this.subs;
            if (subs !== undefined) {
                // Convert the cone's arm-time `Pending` into `Dirty` so a second observer
                // (not just the first reader) sees the change; honored mid-pull by `checkDirty`.
                propagate(subs, runDepth > 0, activeExcluded);
                autoFlush();
            }
        }
    }
    /** @internal */
    _update() {
        if (this.getter !== undefined) {
            if (COUNTS)
                counts.recompute++;
            this.depsTail = undefined;
            this.flags = F.Mutable | F.RecursedCheck;
            const prev = activeSub;
            activeSub = this;
            let threw = true;
            try {
                ++cycle;
                const old = this.currentValue;
                const next = (this.currentValue = this.getter());
                threw = false;
                return !this._equals(old, next);
            }
            finally {
                activeSub = prev;
                this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
                purgeDeps(this);
            }
        }
        // A back-`Pending` source resolves its armed back-write first, so
        // `pendingValue` reflects it before we commit.
        if (this.bflags & BF.Pending && !draining)
            backResolve(this);
        this.flags = F.Mutable;
        const prevV = this.currentValue;
        this.currentValue = this.pendingValue;
        return !this._equals(prevV, this.currentValue);
    }
    /** @internal */
    _notify() { }
    /** @internal */
    _unwatched() {
        // Release each parent→child retaining edge (the `childEdges` up-list) so a
        // disposed view isn't pinned by a long-lived source; a later arm re-links via
        // `markDown`. Skip a still back-marked view — its pending write needs the edge.
        if (!(this.bflags & BACK_MARKED)) {
            for (let e = this.parentEdges; e !== undefined; e = e.nextParent) {
                if (e.linked)
                    unlinkChild(e);
            }
        }
        if (this.getter !== undefined && this.depsTail !== undefined) {
            this.flags = F.Mutable | F.Dirty;
            disposeAllDepsInReverse(this);
            return;
        }
        if (this._unwatchedHook !== undefined)
            this._unwatchedHook();
    }
    peek() {
        const prev = activeSub;
        activeSub = undefined;
        try {
            return this.value;
        }
        finally {
            activeSub = prev;
        }
    }
    // biome-ignore lint/suspicious/noExplicitAny: dispatch over fwd/bwd vs optic chain
    lens(...args) {
        if (typeof args[0] === "function") {
            return buildLens(this.constructor, [this, ...args]);
        }
        return buildLens(CELL_CTOR, [this, ...args]);
    }
    /** Read-only same-type view: the RO dual of the endo `.lens`. For a cross-type view use the typed static
     *  `Target.derive(src, fn)`. */
    derive(fn) {
        return buildDerived(this.constructor, () => fn(this.value));
    }
    /** Backward fan-in: forwards its parent's value unchanged; on write, folds N
     *  contributors into one value. `fold` defaults to last-writer-wins. */
    merge(fold) {
        if (this.getter !== undefined && this._bwd === undefined) {
            throw new TypeError("merge: receiver is read-only");
        }
        const parent = this;
        const cell = new this.constructor();
        cell.flags = F.Mutable | F.Dirty;
        cell.getter = () => parent.value;
        const b = (cell._bwd = new BwdSpec());
        b.merge = new MergeNode(fold);
        linkLens(cell, parent, 0);
        setWriteBlocked(cell);
        return cell;
    }
    // biome-ignore lint/suspicious/noExplicitAny: dispatch
    static derive(...args) {
        return buildDerive(this, args);
    }
    // biome-ignore lint/suspicious/noExplicitAny: dispatch
    static lens(...args) {
        return buildLens(this, args);
    }
    /** Type predicate against this class: `Vec.is(x)` narrows `x` to `Vec`.
     *  Inherited static; works for any subclass via polymorphic `this`. */
    static is(v) {
        return v instanceof this;
    }
    /** Coerce `Val<Inner<Cls>>` → `Cls`: instance → identity, RO cell →
     *  tracked `derive`, literal → fresh seed. */
    static coerce(v) {
        if (v instanceof this)
            return v;
        if (v instanceof Cell) {
            // biome-ignore lint/suspicious/noExplicitAny: dispatch
            return this.derive(() => readNow(v));
        }
        return new this(v);
    }
    /** Writable-shaped constant: always reads `v`, absorbs writes
     *  (parentless sink lens), for APIs demanding bidirectionality. */
    static pin(v) {
        const cell = new this();
        cell.flags = F.Mutable | F.Dirty;
        cell.getter = () => v;
        // Parentless `_bwd`: `writeBack` absorbs it (no parent edges, no closure).
        cell._bwd = new BwdSpec();
        return cell;
    }
}
/** Typed field lens onto `parent.value[key]`. RO parent → RO derive;
 *  writable parent → bidirectional lens with spread-replace `put`. */
function fieldOf(
// biome-ignore lint/suspicious/noExplicitAny: parent is contravariant on put
parent, key, Cls) {
    const ctor = Cls;
    const get = (s) => s[key];
    const ro = parent.getter !== undefined && parent._bwd === undefined;
    if (ro) {
        return buildDerived(ctor, () => get(parent.value));
    }
    // Spread-replace put, array-aware: cloning an array with object spread would
    // demote it to a plain record, so copy via `slice` and set the index.
    const put = (v, s) => {
        if (Array.isArray(s)) {
            const next = s.slice();
            next[key] = v;
            return next;
        }
        return { ...s, [key]: v };
    };
    return buildLens(ctor, [parent, get, put]);
}
// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildDerived(Cls, getter) {
    const cell = new Cls();
    cell.getter = getter;
    cell.flags = F.Mutable | F.Dirty;
    return cell;
}
// Shared N-input read getter: refill a construction-owned buffer from the parents
// each read (no per-read alloc), then apply `fwd`.
function arrayGetter(parents, fwd) {
    const n = parents.length;
    const vals = new Array(n);
    return () => {
        for (let i = 0; i < n; i++)
            vals[i] = parents[i].value;
        return fwd(vals);
    };
}
// Bind a pure (complement-free) optic to one source. Source-reading vs iso is the
// `put` arity. The 1→1 getter/put stays scalar.
function bindPureScalar(Cls, p, optic) {
    const get = optic.get;
    const put = optic.put;
    const readsSource = put.length >= 2;
    const cell = new Cls();
    cell.flags = F.Mutable | F.Dirty;
    const b = (cell._bwd = new BwdSpec());
    cell.getter = (() => get(p.value));
    // Source-reading lenses linearize at the parent's primal (`backPrimal`), so the
    // engine always calls the 1-arg form and never recomputes the parent's cone.
    b.put = readsSource ? (t) => put(t, backPrimal(p)) : put;
    linkLens(cell, p, 0);
    setWriteBlocked(cell);
    return cell;
}
function bindPureTuple(Cls, parents, optic) {
    const get = optic.get;
    const put = optic.put;
    const readsSource = put.length >= 2;
    const n = parents.length;
    const cell = new Cls();
    cell.flags = F.Mutable | F.Dirty;
    const b = (cell._bwd = new BwdSpec());
    cell.getter = arrayGetter(parents, get);
    b.scatter = true;
    for (let i = 0; i < n; i++)
        linkLens(cell, parents[i], i);
    if (readsSource) {
        // Own reused buffer (not the getter's) to avoid aliasing; `put` consumes it
        // synchronously and must not retain it.
        const argbuf = new Array(n);
        const putN = put;
        b.put = (target) => {
            for (let i = 0; i < n; i++)
                argbuf[i] = backPrimal(parents[i]);
            return putN(target, argbuf);
        };
    }
    else {
        const put0 = put;
        b.put = (target) => put0(target);
    }
    setWriteBlocked(cell);
    return cell;
}
// Bind one optic to a source (cell or array). The four shapes (scalar/tuple ×
// pure/stateful) fall out of `Array.isArray(parent)` and the `complement` discriminant.
function bindOne(Cls, parent, optic) {
    if (Array.isArray(parent)) {
        const parents = parent;
        return optic.complement !== undefined
            ? buildStateful(Cls, parents, optic)
            : bindPureTuple(Cls, parents, optic);
    }
    const p = parent;
    return optic.complement !== undefined
        ? buildStateful1(Cls, p, optic)
        : bindPureScalar(Cls, p, optic);
}
// One writable-lens constructor over all call forms. `(parent, fwd, bwd)` is sugar
// for an inline pure optic; `(parent, ...optics)` folds an optic chain by repeated
// binding (each optic bound to the prior result; only the last stage takes `Cls`).
// Composition is just re-binding, so `cell.ts` needs no optic.ts import.
// biome-ignore lint/suspicious/noExplicitAny: dispatch over the untyped call forms
function buildLens(Cls, args) {
    const parent0 = args[0];
    const cls = Cls;
    if (typeof args[1] === "function") {
        // `(parent, fwd, bwd)` → an inline pure optic, then bind.
        let parent = parent0;
        let get = args[1];
        let put = args[2];
        // Object-keyed parents → rewrite to the positional array form (key order fixed
        // once; omitted backward keys become SKIP).
        if (parent0 !== null &&
            typeof parent0 === "object" &&
            !Array.isArray(parent0) &&
            !(parent0 instanceof Cell)) {
            const keys = Object.keys(parent0);
            const rec = parent0;
            const getObj = get;
            const putObj = put;
            const toObj = (vals) => {
                const o = {};
                for (let i = 0; i < keys.length; i++)
                    o[keys[i]] = vals[i];
                return o;
            };
            parent = keys.map(k => rec[k]);
            get = ((vals) => getObj(toObj(vals)));
            put = ((t, vals) => {
                const o = putObj(t, toObj(vals));
                return keys.map(k => (k in o ? o[k] : SKIP));
            });
        }
        return bindOne(cls, parent, { get, put });
    }
    // Optic value(s): fold the chain by repeated binding.
    let acc = parent0;
    const last = args.length - 1;
    for (let i = 1; i <= last; i++) {
        acc = bindOne(i === last ? cls : CELL_CTOR, acc, args[i]);
    }
    return acc;
}
// Seed the complement object from the current sources (fresh per bind).
function seedComplement(optic, seed) {
    return optic.complement(seed);
}
// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful(Cls, parents, optic) {
    const n = parents.length;
    const vals = new Array(n);
    const cell = new Cls();
    cell.flags = F.Mutable | F.Dirty;
    const b = (cell._bwd = new BwdSpec());
    const seed = new Array(n);
    for (let i = 0; i < n; i++)
        seed[i] = parents[i].peek();
    const c = (b.stateful = seedComplement(optic, seed));
    const get = optic.get;
    b.put = optic.put;
    b.scatter = true;
    for (let i = 0; i < n; i++)
        linkLens(cell, parents[i], i);
    // Forward-only refresh: `get` reads the sources and (idempotently) updates the
    // complement; the cache runs it once per source-version change.
    cell.getter = (() => {
        for (let i = 0; i < n; i++)
            vals[i] = parents[i].value;
        return get(vals, c);
    });
    setWriteBlocked(cell);
    return cell;
}
// Single-source stateful fast-path: one parent, so no `vals` buffer and a scalar
// `get`/`put` — minus the array work of the N-source `buildStateful`.
// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful1(Cls, parent, optic) {
    const cell = new Cls();
    cell.flags = F.Mutable | F.Dirty;
    const b = (cell._bwd = new BwdSpec());
    const c = (b.stateful = seedComplement(optic, parent.peek()));
    const get = optic.get;
    b.put = optic.put;
    // `scatter` stays false: writeBack routes this through the scalar stateful branch.
    linkLens(cell, parent, 0);
    cell.getter = (() => get(parent.value, c));
    setWriteBlocked(cell);
    return cell;
}
// One read-only-derive constructor: a bare closure (`derive(fn)`), a single tracked
// read (`derive(p, fn)`), or an N-parent read (`derive(ps, fn)`).
// biome-ignore lint/suspicious/noExplicitAny: dispatch over the untyped call forms
function buildDerive(Cls, args) {
    if (args.length === 1)
        return buildDerived(Cls, args[0]);
    const parent = args[0];
    const fn = args[1];
    if (Array.isArray(parent))
        return buildDerived(Cls, arrayGetter(parent, fn));
    return buildDerived(Cls, () => fn(parent.value));
}
// Prototype accessor (not a class accessor): V8 JITs it better, keeps a stable hidden class.
Object.defineProperty(Cell.prototype, "value", {
    get() {
        // Reading is the PULL: a back-marked cell resolves here, before its own
        // compute, so a source-reading `put` never re-enters a half-computed cell.
        if (this.bflags & BACK_MARKED && !draining)
            backResolve(this);
        const flags = this.flags;
        if (this.getter !== undefined) {
            if (flags & F.RecursedCheck) {
                throw new RangeError(`Cyclic computed: ${this.name ?? this.constructor.name ?? "?"} read its own value`);
            }
            if (flags & F.Dirty ||
                (flags & F.Pending &&
                    (checkDirty(this.deps, this) || ((this.flags = flags & ~F.Pending), false)))) {
                if (this._update()) {
                    const subs = this.subs;
                    if (subs !== undefined)
                        shallowPropagate(subs);
                }
            }
            if (activeSub !== undefined)
                link(this, activeSub, cycle);
            return this.currentValue;
        }
        // Source path.
        if (flags & F.Dirty) {
            this.flags = F.Mutable;
            const prevV = this.currentValue;
            this.currentValue = this.pendingValue;
            if (!this._equals(prevV, this.currentValue)) {
                const subs = this.subs;
                if (subs !== undefined)
                    shallowPropagate(subs);
            }
        }
        if (activeSub !== undefined)
            link(this, activeSub, cycle);
        return this.currentValue;
    },
    set(next) {
        if (this.getter === undefined) {
            this._writeSource(next);
            return;
        }
        const b = this._bwd;
        if (b === undefined) {
            throw new TypeError("Cannot write to a computed");
        }
        // GetPut for a multi-parent split: absorb a write equal to the current view
        // (its `put` could redistribute sources). Stateful excluded — peeking would run
        // `get` and mutate its complement.
        if (b.scatter && b.stateful === undefined && this._equals(next, this.peek())) {
            return;
        }
        arm(this, next);
    },
    enumerable: false,
    configurable: false,
});
// ─────────────────────────────────────────────────────────────────────────
// Backward graph engine (internal) — arm / markDown / resolveCone / writeBack.
// ─────────────────────────────────────────────────────────────────────────
/** Backward push: arm a back-write of `target` on view `node` (dual of a source
 *  `set`). A re-write of a still-armed view keeps only the last target (the path
 *  is already marked); `autoFlush` wakes the effects the push woke. */
function arm(node, target) {
    // Structural reject first: a write whose back-spine dead-ends throws before
    // touching any backward state (atomic — nothing armed, nothing marked).
    if (node.bflags & BF.WriteBlocked) {
        if (COUNTS)
            counts.armBlocked++;
        throw new TypeError("Cannot write through to a computed");
    }
    if (COUNTS)
        counts.arm++;
    if (!(node.bflags & BF.Dirty)) {
        markDown(node); // flag path + wake cones FIRST (a throw arms nothing)
        node.bflags |= BF.Dirty;
    }
    node.pendingValue = target;
    autoFlush();
}
/** MARK (push), dual of `propagate`: descend `start`'s static back-path down
 *  `parentEdges` to its sources, flag each `BF.Pending`, and wake every source's
 *  forward cone. Runs no `put`.
 *
 *  `BF.Pending` self-dedups: an already-marked node has its subtree marked, so
 *  descent stops (diamonds cost one visit). A read-only-derived parent is skipped
 *  (a split routes around it; a sole one is pre-rejected by `arm`'s
 *  `BF.WriteBlocked` check). The 1→1 spine allocates nothing. */
function markDown(start) {
    let node = start;
    let stack;
    for (;;) {
        if (COUNTS)
            counts.markDownVisit++;
        let next;
        if (isSource(node)) {
            // Leaf (dual of a `Dirty` source): wake its cone ONCE.
            if (!(node.bflags & BF.Pending)) {
                node.bflags |= BF.Pending;
                const subs = node.subs;
                if (subs !== undefined)
                    propagate(subs, runDepth > 0, activeExcluded);
            }
        }
        else if (node === start || !(node.bflags & BF.Pending)) {
            // On the back-path. An already-marked intermediate (≠ start) has its
            // subtree marked — stop (diamond dedup).
            if (node !== start)
                node.bflags |= BF.Pending;
            for (let e = node.parentEdges; e !== undefined; e = e.nextParent) {
                linkChild(e); // register this view on the parent's up-list (arm-order)
                const p = e.parent;
                // Read-only parent: a split routes around it (its `put` SKIPs it). A sole
                // read-only parent can't be routed — but that's `BF.WriteBlocked`, already
                // rejected in `arm`, so the descent never reaches such a node here.
                if (isReadOnlyDerived(p))
                    continue;
                if (next === undefined)
                    next = p;
                else
                    (stack ??= []).push(p);
            }
        }
        if (next !== undefined) {
            node = next;
        }
        else if (stack !== undefined && stack.length > 0) {
            node = stack.pop();
        }
        else {
            return;
        }
    }
}
/** RESOLVE (pull), dual of `checkDirty`: resolve one node's whole back-cone by
 *  ascending `childEdges` to the armed views and `writeBack`ing each. Source-centric
 *  — a call on a source resolves every co-writer together and commits once.
 *
 *  Iterative post-order via an explicit {node, next-child cursor} frame stack:
 *  pre-order clears a merge's buffer and drives an armed target (`enterCone`);
 *  post-order clears `BF.Pending` and folds a merge at its true position. Children
 *  walk in `childEdges` order (co-writer last-write-wins); `bEpoch` dedups diamonds.
 *  Idempotent, so `backResolve`'s phase 2 can call it unconditionally. */
function resolveCone(root) {
    const epoch = ++backCycle;
    root.bEpoch = epoch;
    enterCone(root);
    rcNode[0] = root;
    rcEdge[0] = root.childEdges;
    let fp = 1;
    while (fp > 0) {
        let e = rcEdge[fp - 1];
        let descended = false;
        while (e !== undefined) {
            const c = e.child;
            e = e.nextChild;
            if (c.bflags & BACK_MARKED && c.bEpoch !== epoch) {
                c.bEpoch = epoch;
                rcEdge[fp - 1] = e; // resume here when we pop back to this frame
                enterCone(c);
                rcNode[fp] = c;
                rcEdge[fp] = c.childEdges;
                fp++;
                descended = true;
                break;
            }
        }
        if (descended)
            continue;
        // Children exhausted → post-order work for this frame's node.
        const node = rcNode[--fp];
        node.bflags &= ~BF.Pending;
        const b = node._bwd;
        // A merge has exactly one parent-edge; fold its gathered contributions to it.
        if (b !== undefined && b.merge !== undefined)
            foldMerge(node.parentEdges.parent, b.merge);
    }
}
/** `resolveCone` pre-order work: reset a merge's buffer, drive an armed target. */
function enterCone(node) {
    if (COUNTS)
        counts.resolveConeVisit++;
    const b = node._bwd;
    if (b !== undefined && b.merge !== undefined)
        b.merge.contributions.length = 0;
    if (node.bflags & BF.Dirty) {
        node.bflags &= ~BF.Dirty;
        writeBack(node, node.pendingValue);
    }
}
/** PULL entry for a back-marked `start`. A source resolves its own cone; a view
 *  first descends its marked back-path to the sources, then resolves each. The
 *  `draining` guard stops a `put`'s source read from re-entering.
 *
 *  Two-phase: phase 1 collects the distinct sources (clearing nothing), phase 2
 *  `resolveCone`s each. Capturing the full source set before any `writeBack` runs
 *  means a sibling commit can't drop a co-writer's source from the worklist. A
 *  per-call `bEpoch` stamp dedups the descent (diamonds visit each node once). */
function backResolve(start) {
    draining = true;
    ++batchDepth;
    const prev = activeSub;
    activeSub = undefined;
    const sourcesBase = backSources.length;
    const epoch = ++backCycle;
    try {
        if (isSource(start)) {
            resolveCone(start);
            return;
        }
        // Phase 1 (collect): descend the `BF.Pending` cone, gathering distinct
        // sources. `reached` = a source was found (else `start` is a `pin` sink).
        let node = start;
        let stack;
        let reached = false;
        for (;;) {
            let next;
            for (let e = node.parentEdges; e !== undefined; e = e.nextParent) {
                const p = e.parent;
                if (!(p.bflags & BF.Pending) || p.bEpoch === epoch)
                    continue;
                p.bEpoch = epoch;
                if (isSource(p)) {
                    reached = true;
                    backSources.push(p);
                }
                else if (next === undefined)
                    next = p;
                else
                    (stack ??= []).push(p);
            }
            if (next !== undefined)
                node = next;
            else if (stack !== undefined && stack.length > 0)
                node = stack.pop();
            else
                break;
        }
        // Phase 2 (resolve): each collected source's whole cone, once.
        for (let i = sourcesBase; i < backSources.length; i++)
            resolveCone(backSources[i]);
        if (!reached && start.bflags & BF.Dirty) {
            start.bflags &= ~BF.Dirty;
            writeBack(start, start.pendingValue);
        }
    }
    finally {
        backSources.length = sourcesBase;
        activeSub = prev;
        --batchDepth;
        draining = false;
    }
}
/** Resolve any back-write a woken node reads directly. `checkDirty` catches
 *  back-writes that move a source, but a stateful stash moves only the VIEW (no
 *  source changes) — invisible to a source-based check, so resolve this node's
 *  back-marked deps here. A forward-only wake walks no cone and pays nothing. */
function resolveBackDeps(node) {
    for (let l = node.deps; l !== undefined; l = l.nextDep) {
        const d = l.dep;
        if (d.bflags & BACK_MARKED && !draining)
            backResolve(d);
    }
}
/** Backward commit/compute (dual of `_update`): drive a back-write of `target`
 *  toward the sources, applying each lens's `put` and staging each source as it's
 *  reached (so a later sibling composes rather than clobbers). A `SKIP` slot prunes
 *  a branch; every other slot is written verbatim, `undefined` included.
 *
 *  Iterative depth-first, left-to-right (children pushed in reverse onto the
 *  pooled `wbNode`/`wbTarget` stack), so a sibling read sees a prior sibling's
 *  staged write — bounded by pooled stack memory, not the call stack. */
function writeBack(node, target) {
    wbNode[0] = node;
    wbTarget[0] = target;
    let top = 1;
    while (top > 0) {
        if (COUNTS)
            counts.writeBackVisit++;
        const cur = wbNode[--top];
        const tgt = wbTarget[top];
        if (isSource(cur)) {
            cur._writeSource(tgt); // staged now, visible to later siblings
            // Clear `BF.Pending`, then re-assert iff a lens-child is still armed (an
            // overlapping co-writer); else leaving it set would strand `BF.Pending` on
            // every fan-in source. Scan from the tail (where `resolveCone` leaves the last
            // still-armed co-writer), turning a fan-in re-assert from O(N²) into O(N).
            cur.bflags &= ~BF.Pending;
            for (let e = cur.childEdgesTail; e !== undefined; e = e.prevChild) {
                if (COUNTS)
                    counts.reassertScan++;
                if (e.child.bflags & BACK_MARKED) {
                    cur.bflags |= BF.Pending;
                    break;
                }
            }
            continue;
        }
        cur.bflags &= ~BF.Pending; // passing through clears the path marker
        const b = cur._bwd;
        if (b === undefined)
            throw new TypeError("Cannot write through to a computed");
        const mn = b.merge;
        if (mn !== undefined) {
            mn.contributions.push(tgt); // gathered here; `resolveCone` folds post-order
            continue;
        }
        const pe = cur.parentEdges;
        if (pe === undefined)
            continue; // pin sink (parentless): absorb
        const sc = b.stateful;
        if (sc !== undefined && !b.scatter) {
            // Single-source stateful fast-path (scalar `bwd`); one index-0 parent edge.
            const p = pe.parent;
            const x = p.value;
            if (COUNTS)
                counts.put++;
            // `put` sees the last-read complement (+ fresh source) and may mutate it;
            // it returns just the scalar update (or SKIP).
            const u = b.put(tgt, x, sc);
            if (u !== SKIP) {
                wbNode[top] = p;
                wbTarget[top] = u;
                top++;
            }
            else {
                // Stash: the view moved through the complement alone (see the scatter case).
                cur.flags |= F.Dirty;
                const subs = cur.subs;
                if (subs !== undefined)
                    propagate(subs, runDepth > 0, activeExcluded);
            }
            continue;
        }
        if (b.scatter) {
            // Gather ordered parents (index-ordered edges) for the tuple `put`.
            let n = 0;
            for (let e = pe; e !== undefined; e = e.nextParent)
                n++;
            const parents = new Array(n);
            for (let e = pe; e !== undefined; e = e.nextParent)
                parents[e.index] = e.parent;
            let out;
            if (sc !== undefined) {
                const vals = new Array(n);
                for (let i = 0; i < n; i++)
                    vals[i] = parents[i].value;
                if (COUNTS)
                    counts.put++;
                // `put` sees the last-read complement (+ fresh sources) and may mutate it;
                // it reconstructs any current-source facts it needs from `vals`.
                out = b.put(tgt, vals, sc);
            }
            else {
                if (COUNTS)
                    counts.put++;
                out = b.put(tgt);
            }
            // Push non-SKIP children in REVERSE so index 0 is popped (processed) first
            // — depth-first, left-to-right. A short `out` skips the trailing parents.
            let wrote = false;
            const m = out.length < n ? out.length : n;
            for (let i = m - 1; i >= 0; i--) {
                const u = out[i];
                if (u !== SKIP) {
                    wrote = true;
                    wbNode[top] = parents[i];
                    wbTarget[top] = u;
                    top++;
                }
            }
            // A stateful lens can change its VIEW through the complement alone, moving no
            // source (a "stash"; `!wrote` ⇒ no children pushed). The forward cone never
            // fires, so invalidate this node's cache and propagate to its observers here.
            if (!wrote && sc !== undefined) {
                cur.flags |= F.Dirty;
                const subs = cur.subs;
                if (subs !== undefined)
                    propagate(subs, runDepth > 0, activeExcluded);
            }
            continue;
        }
        // 1→1 lens (single index-0 parent-edge). A `SKIP` rejects the write: the
        // source is left, so invalidate this view and propagate (it recomputes to old).
        if (COUNTS)
            counts.put++;
        {
            const u = b.put(tgt);
            if (u !== SKIP) {
                wbNode[top] = pe.parent;
                wbTarget[top] = u;
                top++;
            }
            else {
                cur.flags |= F.Dirty;
                const subs = cur.subs;
                if (subs !== undefined)
                    propagate(subs, runDepth > 0, activeExcluded);
            }
        }
    }
}
/** Fold a merge's contributions once (policy; default last-writer-wins) and write
 *  the result up to its parent. Called post-order from `resolveCone`. */
function foldMerge(parent, mn) {
    if (COUNTS)
        counts.fold++;
    const vals = mn.contributions;
    const fold = mn.foldFn;
    let folded;
    if (fold !== undefined)
        folded = fold(vals);
    else if (vals.length > 0)
        folded = vals[vals.length - 1];
    else
        return; // last-writer-wins with no contributor: leave the parent
    vals.length = 0; // reuse the merge-owned buffer in place (fold must not retain it)
    writeBack(parent, folded);
}
// ─────────────────────────────────────────────────────────────────────────
// Public API — factories (cell / derive / lens) over the builders above.
// ─────────────────────────────────────────────────────────────────────────
/** Writable source; passes an existing `Writable` through (idempotent). */
function cell(initial, opts) {
    if (initial instanceof Cell)
        return initial;
    return new Cell(initial, opts);
}
// Bare (untyped) factories: plain `Cell`, inferring `R` from the closures.
const CELL_CTOR = Cell;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
function derive(...args) {
    return buildDerive(CELL_CTOR, args);
}
// biome-ignore lint/suspicious/noExplicitAny: dispatch
function lens(...args) {
    return buildLens(CELL_CTOR, args);
}
// ─────────────────────────────────────────────────────────────────────────
// Effects & schedulers — the Effect watcher (internal) and the public
// effect / batch / network / flush surface built on it.
// ─────────────────────────────────────────────────────────────────────────
// Effect — one watcher class for both auto-tracked effects and explicit-topology
// networks: alien-signals' effect plus the `EM` mode toggles `network()` needs.
class Effect {
    flags = F.Watching | F.RecursedCheck;
    subs = undefined;
    subsTail = undefined;
    deps = undefined;
    depsTail = undefined;
    fn;
    cleanup = undefined;
    /** Watcher-behavior bits (`EM`); `EM.None` for a plain effect. */
    mode;
    constructor(fn, mode = EM.None) {
        this.fn = fn;
        this.mode = mode;
    }
    _update() {
        this.flags = F.Mutable;
        return true;
    }
    _notify() {
        const mode = this.mode;
        if (mode & EM.Manual) {
            this.flags |= F.Watching; // re-arm but don't queue; only `flush()` advances
            return;
        }
        if (mode & EM.Sync) {
            // Eager watcher (network): append + force a synchronous flush.
            queued[queuedLength++] = this;
            syncFlush = true;
            this.flags &= ~F.Watching;
            return;
        }
        // Plain effect: batch-insert this effect and any subscribed to it, in
        // dependency order (alien-signals).
        let e = this;
        let insertIndex = queuedLength;
        const firstInsertedIndex = insertIndex;
        do {
            queued[insertIndex++] = e;
            e.flags &= ~F.Watching;
            const next = e.subs?.sub;
            if (next === undefined || !(next.flags & F.Watching))
                break;
            e = next;
        } while (true);
        queuedLength = insertIndex;
        let idx = insertIndex, firstIdx = firstInsertedIndex;
        while (firstIdx < --idx) {
            const left = queued[firstIdx];
            queued[firstIdx++] = queued[idx];
            queued[idx] = left;
        }
    }
    _unwatched() {
        this.flags = F.None;
        disposeAllDepsInReverse(this);
        const sub = this.subs;
        if (sub !== undefined)
            unlink(sub);
        if (this.cleanup)
            this._runCleanup();
    }
    _run() {
        // Resolve back-writes this node reads directly (incl. view-only stashes);
        // `checkDirty` resolves any back-`Pending` source reached deeper.
        if (this.deps !== undefined)
            resolveBackDeps(this);
        const flags = this.flags;
        if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps, this))) {
            if (this.cleanup) {
                this._runCleanup();
                if (!this.flags)
                    return;
            }
            this._invoke();
        }
        else if (this.deps !== undefined) {
            this.flags = F.Watching;
        }
    }
    /** Run the body — the single path for first fire, scheduled re-run, and manual
     *  `flush()`. Auto-tracks deps unless `NoTrack`; self-excludes writes under `Exclude`. */
    _invoke() {
        const noTrack = this.mode & EM.NoTrack;
        if (!noTrack)
            this.depsTail = undefined;
        this.flags = F.Watching | F.RecursedCheck;
        const prevSub = activeSub;
        const prevExc = activeExcluded;
        activeSub = noTrack ? undefined : this;
        if (this.mode & EM.Exclude)
            activeExcluded = this;
        try {
            ++cycle;
            ++runDepth;
            const ret = this.fn();
            this.cleanup = typeof ret === "function" ? ret : undefined;
        }
        finally {
            --runDepth;
            activeSub = prevSub;
            activeExcluded = prevExc;
            this.flags &= ~F.RecursedCheck;
            if (!noTrack)
                purgeDeps(this);
        }
    }
    _runCleanup() {
        const c = this.cleanup;
        this.cleanup = undefined;
        const prev = activeSub;
        activeSub = undefined;
        try {
            c();
        }
        finally {
            activeSub = prev;
        }
    }
}
function effect(fn) {
    const e = new Effect(fn);
    e._invoke();
    return () => e._unwatched();
}
/** Run effects woken by a write. Backward work is pulled lazily per read, so
 *  flush owns no backward bookkeeping — just the effect queue. */
function flush() {
    if (flushing)
        return;
    flushing = true;
    // Error locality: one effect throwing must not strand its siblings. Drain the
    // whole queue, catching each body, and surface the first error after it empties
    // (later errors dropped). A throwing body isn't re-queued; it re-arms on next wake.
    let err;
    let threw = false;
    try {
        while (notifyIndex < queuedLength) {
            const e = queued[notifyIndex];
            queued[notifyIndex++] = undefined;
            try {
                e._run();
            }
            catch (ex) {
                if (!threw) {
                    err = ex;
                    threw = true;
                }
            }
        }
    }
    finally {
        notifyIndex = 0;
        queuedLength = 0;
        syncFlush = false;
        flushing = false;
    }
    if (threw)
        throw err;
}
/** Queue an effect flush for the end of the current microtask turn (idempotent).
 *  A write wakes effects asynchronously; many writes in one turn coalesce. */
function schedule() {
    if (scheduled)
        return;
    scheduled = true;
    queueMicrotask(() => {
        scheduled = false;
        flush();
    });
}
/** Resolve the queue after a write: no-op inside a `batch`/flush (the barrier
 *  owns flushing), else synchronously if a `Sync` watcher is waiting (eager
 *  solve) or deferred to the microtask (coalesced effects). */
function autoFlush() {
    if (batchDepth !== 0 || flushing)
        return;
    if (syncFlush)
        flush();
    else
        schedule();
}
/** Run all pending effects now, synchronously — the escape hatch for code that
 *  must observe effect side-effects before yielding. Reads never need it. */
function settle() {
    flush();
}
/** Group writes and flush effects synchronously at the end of `fn`. Effects
 *  coalesce on the microtask turn anyway; reach for `batch` only to run the woken
 *  effects before the call returns. */
function batch(fn) {
    ++batchDepth;
    try {
        return fn();
    }
    finally {
        if (!--batchDepth)
            flush();
    }
}
function untracked(fn) {
    const prev = activeSub;
    activeSub = undefined;
    try {
        return fn();
    }
    finally {
        activeSub = prev;
    }
}
/** Build a reactive sub-DAG. The body fires when any subscribed dep changes
 *  (`dirty` = the changed subset), self-excludes its own writes, and (auto mode)
 *  resolves synchronously. `manual: true` defers firing so only `flush()` advances;
 *  `flush()` from inside the body throws. Network-specific state (last-values,
 *  handle) lives in this closure, so the shared `Effect` carries none of it. */
function network(
// biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
deps, body, opts) {
    const lastValues = new Map();
    const depsSet = new Set();
    let ownCycle = 0;
    let disposed = false;
    // Forward-declared so the closures below can reach the node; assigned before
    // any runs (the first `_invoke` happens after construction).
    let node;
    const computeDirty = () => {
        let dirty;
        for (const [c, last] of lastValues) {
            if (c.peek() !== last)
                (dirty ??= new Set()).add(c);
        }
        return dirty ?? EMPTY_DIRTY;
    };
    const linkDeps = (cells) => {
        let tail = node.deps;
        if (tail !== undefined)
            while (tail.nextDep !== undefined)
                tail = tail.nextDep;
        node.depsTail = tail;
        for (const s of cells) {
            if (depsSet.has(s))
                continue;
            depsSet.add(s);
            link(s, node, ++ownCycle);
        }
    };
    const unlinkDeps = (cells) => {
        for (const s of cells) {
            if (!depsSet.has(s))
                continue;
            depsSet.delete(s);
            for (let l = node.deps; l !== undefined; l = l.nextDep) {
                if (l.dep === s) {
                    unlink(l, node);
                    break;
                }
            }
        }
    };
    const handle = {
        dispose: () => {
            if (disposed)
                return;
            disposed = true;
            node._unwatched();
            lastValues.clear();
        },
        flush: () => {
            if (disposed)
                return;
            // RecursedCheck doubles as the "body running" guard.
            if (node.flags & F.RecursedCheck) {
                throw new Error("network: flush() called from inside body — would recurse infinitely.");
            }
            batch(() => node._invoke());
        },
        subscribe: (...cells) => {
            if (!disposed)
                linkDeps(cells);
        },
        unsubscribe: (...cells) => {
            if (!disposed)
                unlinkDeps(cells);
        },
    };
    // The Effect body: hand the changed subset to the user body, then re-snapshot
    // the deps for the next fire.
    const run = () => {
        const dirty = computeDirty();
        try {
            body(dirty, handle);
        }
        finally {
            lastValues.clear();
            for (let l = node.deps; l !== undefined; l = l.nextDep) {
                const c = l.dep;
                lastValues.set(c, c.peek());
            }
        }
    };
    node = new Effect(run, EM.NoTrack | EM.Exclude | (opts?.manual ? EM.Manual : EM.Sync));
    linkDeps(deps);
    batch(() => node._invoke()); // first fire (lastValues empty ⇒ EMPTY_DIRTY)
    return handle;
}
// ── value-class authoring helpers ──────────────────────────────────
// `fieldLens`/`cachedDerive` are the two getter forms a value class declares;
// the choice between them is the local declaration of writability. For arbitrary
// cached views, use `lazy()` directly.
/** Bidirectional field lens onto `parent.value[key]` (write spread-replaces),
 *  cached per (instance, key). `Writable<Cls>` on a writable parent, bare `Cls` on RO.
 *
 *      get x() { return fieldLens(this, "x", Num); } */
function fieldLens(parent, key, Cls) {
    return lazy(parent, key, () => fieldOf(parent, key, Cls));
}
/** Read-only derived view via `Cls.derive(parent, fn)`, memoized per
 *  (instance, key).
 *
 *      get magnitude() {
 *        return cachedDerive(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
 *      } */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.derive
function cachedDerive(parent, key, Cls, fn) {
    // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
    return lazy(parent, key, () => Cls.derive(parent, fn));
}
/** Every cell `s` transitively depends on, including itself (BFS, peeking each
 *  computed to populate deps; `seen` breaks cycles). */
function transitiveDeps(s) {
    const seen = new Set();
    const queue = [s];
    while (queue.length > 0) {
        const cur = queue.shift();
        if (seen.has(cur))
            continue;
        seen.add(cur);
        const c = cur;
        if (c.getter !== undefined) {
            void cur.value;
            let l = c.deps;
            while (l !== undefined) {
                queue.push(l.dep);
                l = l.nextDep;
            }
        }
    }
    return seen;
}

global.Bireactive=Object.freeze({version:"0.3.5",Cell,cell,lens,derive,effect,batch,settle,untracked,isCell,isLens});
})(globalThis);

;
// Numerical geometry shared by the story widgets.
// Derived from constellations.html; the preserved animations remain independent.
'use strict';
window.PlankGeometry=(()=>{
const TAU=Math.PI*2,SAMPLE_COUNT=240,AREA_EPSILON=1e-9;
const settings={shape:'morph',count:84,width:1,layout:'packed',budgetPattern:'tighter'};
function clip(poly, nx, ny, c) {
 if (poly.length < 3) return [];
 const out = [];
 let a = poly[poly.length-1], da = nx*a[0]+ny*a[1]-c;
 for (const b of poly) {
  const db = nx*b[0]+ny*b[1]-c;
  if ((da<=0)!==(db<=0)) { const t=da/(da-db); out.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]); }
  if (db<=0) out.push(b);
  a=b; da=db;
 }
 return out;
}
function measure(poly) {
 let twiceArea=0,mx=0,my=0;
 for(let i=0;i<poly.length;i++) {
  const a=poly[i],b=poly[(i+1)%poly.length],cross=a[0]*b[1]-a[1]*b[0];
  twiceArea+=cross;mx+=(a[0]+b[0])*cross;my+=(a[1]+b[1])*cross;
 }
 return {area:Math.abs(twiceArea)/2,center:Math.abs(twiceArea)>1e-15?[mx/(3*twiceArea),my/(3*twiceArea)]:[0,0]};
}

// Smooth support h(theta)=log(sum(exp(beta*v·n)))/beta+r.
// Curvature radius h+h''=entropy(weights)/beta+beta*Var(v·tangent)+r>0.
// These templates are strictly convex, including the asymmetric ones.
function roundedSupport(vertices,beta,radius,theta) {
 const nx=Math.cos(theta),ny=Math.sin(theta),tx=-ny,ty=nx;
 const dots=vertices.map(v=>v[0]*nx+v[1]*ny),max=Math.max(...dots);
 const exps=dots.map(d=>Math.exp(beta*(d-max))),sum=exps.reduce((a,b)=>a+b,0);
 const h=max+Math.log(sum)/beta+radius;
 let derivative=0;
 vertices.forEach((v,i)=>{derivative+=exps[i]/sum*(v[0]*tx+v[1]*ty);});
 return [h*nx+derivative*tx,h*ny+derivative*ty];
}
function ellipseSupport(a,b,theta) {
 const nx=Math.cos(theta),ny=Math.sin(theta),h=Math.hypot(a*nx,b*ny);
 return [a*a*nx/h,b*b*ny/h];
}
const triangle=Array.from({length:3},(_,i)=>[1.25*Math.cos(TAU*i/3-Math.PI/2),1.25*Math.sin(TAU*i/3-Math.PI/2)]);
const templateFns={
 circle:theta=>[Math.cos(theta),Math.sin(theta)],
 ellipse:theta=>ellipseSupport(1.38,.75,theta),
 triangle:theta=>roundedSupport(triangle,11,.08,theta),
 square:theta=>roundedSupport([[-.83,-.83],[.83,-.83],[.83,.83],[-.83,.83]],9,.07,theta),
 pebble:theta=>roundedSupport([[-.9,-.22],[-.35,-.98],[.4,-.8],[1.02,.12],[.1,.94],[-.7,.69]],5,.10,theta),
 capsule:theta=>roundedSupport([[-.70,0],[.70,0]],9,.57,theta),
};
const templates={};
for(const [name,fn] of Object.entries(templateFns)) {
 const points=Array.from({length:SAMPLE_COUNT},(_,i)=>fn(TAU*i/SAMPLE_COUNT));
 const {area,center}=measure(points),scale=Math.sqrt(Math.PI/area);
 templates[name]=points.map(p=>[(p[0]-center[0])*scale,(p[1]-center[1])*scale]);
}
const shapeCycle=['ellipse','triangle','circle','square','pebble','capsule'];
const smooth=x=>x*x*x*(10+x*(-15+6*x));
function makeBreathingTriangle(time) {
 // A positive-determinant affine map preserves the exact triangle and convexity.
 const scale=Math.sqrt(Math.PI/measure(triangle).area);
 const stretch=Math.exp(.22*Math.sin(time*.11)),shear=.22*Math.sin(time*.08+.5);
 const angle=.10*Math.sin(time*.12)+time*.018,cs=Math.cos(angle),sn=Math.sin(angle),breath=1+.03*Math.sin(time*.21);
 return triangle.map(p=>{
  const x=scale*(p[0]*stretch+p[1]*shear),y=scale*p[1]/stretch;
  return [breath*(cs*x-sn*y),breath*(sn*x+cs*y)];
 });
}
function makeBody(time,shape=settings.shape) {
 if(shape==='breathing')return makeBreathingTriangle(time);
 const phase=time/14+.23,index=Math.floor(phase)%shapeCycle.length,blend=smooth(phase-Math.floor(phase));
 const a=templates[shape==='morph'?shapeCycle[index]:shape];
 const b=shape==='morph'?templates[shapeCycle[(index+1)%shapeCycle.length]]:a,mix=shape==='morph'?blend:0;
 // At common outward normals, interpolating support points gives a Minkowski
 // blend. Positive scale and rotation preserve its convexity at every time.
 const breath=shape==='morph'?1+.045*Math.sin(time*.21):1;
 const angle=.10*Math.sin(time*.12)+time*.018,cs=Math.cos(angle),sn=Math.sin(angle);
 return a.map((p,i)=>{
  const x=(p[0]*(1-mix)+b[i][0]*mix)*breath,y=(p[1]*(1-mix)+b[i][1]*mix)*breath;
  return [cs*x-sn*y,sn*x+cs*y];
 });
}
function makePlanks(body,time,count=settings.count,widthFactor=settings.width,layout=settings.layout) {
 if(layout==='packed')return makePackedPlanks(body,time,count,widthFactor);
 if(layout==='budget')return makeBudgetPlanks(body,time,count,widthFactor,settings.budgetPattern);
 const planks=[];
 for(let i=0;i<count;i++) {
  const phase=i*2.3999632297;
  const angle=i*Math.PI/count+.27+time*(.018+.008*Math.sin(i*1.9))+.26*Math.sin(time*.085+phase);
  const nx=Math.cos(angle),ny=Math.sin(angle);
  let min=Infinity,max=-Infinity;
  for(const p of body){const d=nx*p[0]+ny*p[1];min=Math.min(min,d);max=Math.max(max,d);}
  const bodyWidth=max-min;
  const rw=widthFactor*Math.pow(6/count,.72)*(.15+.052*Math.sin(time*(.21+.011*i)+phase+1));
  const offset=bodyWidth*(.29*Math.sin(time*(.075+.005*i)+phase)+.065*Math.sin(time*.23+i));
  const center=(min+max)/2+offset;
  planks.push({nx,ny,lo:center-bodyWidth*rw/2,hi:center+bodyWidth*rw/2,rw});
 }
 return planks;
}
function makePackedPlanks(body,time,count,widthFactor) {
 // Three families of almost parallel, nearly touching strips cover the body.
 // Tiny intersections of their moving seams are the real uncovered cells.
 // Slightly different angles and widths open and close these intersections.
 const families=3,planks=[];
 for(let family=0;family<families;family++) {
  const m=Math.floor(count/families)+(family<count%families?1:0);
  const angle=family*Math.PI/families+.27+time*.018+.10*Math.sin(time*.07+family*2);
  const nx=Math.cos(angle),ny=Math.sin(angle);
  let min=Infinity,max=-Infinity;
  for(const p of body){const d=nx*p[0]+ny*p[1];min=Math.min(min,d);max=Math.max(max,d);}
  const step=(max-min)/Math.max(1,m-1);
  for(let j=0;j<m;j++) {
   const phase=j*2.3999632297+family*1.6;
   const jitter=.006*Math.min(1,42/count);
   const theta=angle+jitter*Math.sin(time*(.13+.006*j)+phase),cs=Math.cos(theta),sn=Math.sin(theta);
   const center=(m===1?(min+max)/2:min+j*step)+.02*step*Math.sin(time*.37+phase*1.3);
   const half=step*.5*widthFactor*(.85+.16*Math.sin(time*(.32+.009*j)+phase));
   let actualMin=Infinity,actualMax=-Infinity;
   for(const p of body){const d=cs*p[0]+sn*p[1];actualMin=Math.min(actualMin,d);actualMax=Math.max(actualMax,d);}
   planks.push({nx:cs,ny:sn,lo:center-half,hi:center+half,rw:2*half/(actualMax-actualMin)});
  }
 }
 return planks;
}
function bodyProjection(body,nx,ny) {
 let min=Infinity,max=-Infinity;
 for(const p of body){const d=nx*p[0]+ny*p[1];min=Math.min(min,d);max=Math.max(max,d);}
 return {min,max,width:max-min};
}
function makeBudgetPlanks(body,time,count,target,pattern='scatter') {
 // Allocate each width in its own normal direction, with an exact total budget.
 target=Math.max(.90,Math.min(.999,target));
 if(pattern==='pinpricks')return body.length===3?makeClusterPlanks(body,time,count,target):makeCapPlanks(body,time,count,target);
 if(pattern==='tighter')return makeTighterPlanks(body,time,count,target);
 if(pattern==='boundary')return makeBoundaryPlanks(body,time,count,target);
 const planks=[],families=3;
 for(let family=0;family<families;family++) {
  const m=Math.floor(count/families)+(family<count%families?1:0);
  const angle=family*Math.PI/families+.27+time*.018+.14*Math.sin(time*.07+family*2);
  const range=bodyProjection(body,Math.cos(angle),Math.sin(angle)),step=range.width/Math.max(1,m-1);
  for(let j=0;j<m;j++) {
   const phase=j*2.3999632297+family*1.6;
   const theta=angle+.7/m*Math.sin(time*(.13+.006*j)+phase),nx=Math.cos(theta),ny=Math.sin(theta);
   const center=(m===1?(range.min+range.max)/2:range.min+j*step)+.2*step*Math.sin(time*.37+phase*1.3);
   const span=bodyProjection(body,nx,ny).width,weight=.85+.36*Math.sin(time*(.32+.009*j)+phase);
   planks.push({nx,ny,center,span,weight});
  }
 }
 const sum=planks.reduce((s,p)=>s+p.weight,0);
 return planks.map(p=>{
  const rw=target*p.weight/sum,half=p.span*rw/2;
  return {nx:p.nx,ny:p.ny,lo:p.center-half,hi:p.center+half,rw};
 });
}
function makeTighterPlanks(body,time,count,target) {
 // The three unit normals satisfy n2=n0+n1. Coordinated lattice phases
 // bring their crossings together; width is weighted toward the body center.
 // Each family receives exactly one third of the total relative-width budget.
 const counts=Array.from({length:3},(_,i)=>Math.floor(count/3)+(i<count%3?1:0));
 const base=.27+time*.025+.14*Math.sin(time*.07),angles=[base,base+2*Math.PI/3,base+Math.PI/3];
 const center=measure(body).center,ranges=angles.map(a=>bodyProjection(body,Math.cos(a),Math.sin(a)));
 const extent=Math.max(...ranges.map((r,i)=>{
  const c=center[0]*Math.cos(angles[i])+center[1]*Math.sin(angles[i]);
  return Math.max(r.max-c,c-r.min);
 }));
 const spacing=2*extent/Math.max(1,Math.min(...counts)-3);
 const p0=.24*Math.sin(time*.17),p1=.22*Math.sin(time*.13+1.7);
 const phases=[p0,p1,p0+p1+.08*Math.sin(time*.23)],planks=[];
 const fade=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
 for(let f=0;f<3;f++) {
  const nx=Math.cos(angles[f]),ny=Math.sin(angles[f]),range=ranges[f];
  const origin=center[0]*nx+center[1]*ny;
  const centers=Array.from({length:counts[f]},(_,j)=>origin+(j-Math.floor(counts[f]/2)+phases[f])*spacing);
  const weights=centers.map(c=>Math.max(1e-6,
   fade((c-range.min)/spacing+.5)*fade((range.max-c)/spacing+.5)*
   Math.exp(-2.5*Math.pow((c-origin)/(range.width/2),2))));
  const sum=weights.reduce((s,x)=>s+x,0);
  for(let j=0;j<counts[f];j++) {
   const rw=target/3*weights[j]/sum,half=range.width*rw/2,c=centers[j];
   planks.push({nx,ny,lo:c-half,hi:c+half,rw});
  }
 }
 return planks;
}
function makeBoundaryPlanks(body,time,count,target) {
 // One broad plank covers the center. Smaller planks cross the two end caps.
 // Placement uses each cap; relative width always uses the entire body.
 const base=.27+time*.035+.3*Math.sin(time*.07),nx=Math.cos(base),ny=Math.sin(base);
 const span=bodyProjection(body,nx,ny),rw=Math.min(target-.02,.9),w=rw*span.width;
 const center=(span.min+span.max)/2+(span.width-w)*.35*Math.sin(time*.11);
 const primary={nx,ny,lo:center-w/2,hi:center+w/2,rw},planks=[primary];
 const caps=[clip(body,nx,ny,primary.lo),clip(body,-nx,-ny,-primary.hi)],families=3;
 const weights=Array.from({length:count-1},(_,i)=>1+.3*Math.sin(time*.23+i*2.3999632297));
 const sum=weights.reduce((s,x)=>s+x,0);
 let k=0;
 for(let side=0;side<2;side++) {
  const n=Math.floor((count-1)/2)+(side<(count-1)%2?1:0),cap=caps[side].length>=3?caps[side]:body;
  for(let f=0;f<families;f++) {
   const m=Math.floor(n/families)+(f<n%families?1:0),angle=base+f*Math.PI/families+.16*Math.sin(time*.09+f+side);
   const range=bodyProjection(cap,Math.cos(angle),Math.sin(angle)),step=range.width/Math.max(1,m-1);
   for(let j=0;j<m;j++,k++) {
    const phase=j*2.3999632297+f*2.1+side*1.4,theta=angle+.25/Math.max(1,m)*Math.sin(time*.2+phase);
    const cs=Math.cos(theta),sn=Math.sin(theta);
    const c=(m===1?(range.min+range.max)/2:range.min+j*step)+.22*step*Math.sin(time*(.27+.008*j)+phase);
    const rw=(target-primary.rw)*weights[k]/sum,width=rw*bodyProjection(body,cs,sn).width;
    planks.push({nx:cs,ny:sn,lo:c-width/2,hi:c+width/2,rw});
   }
  }
 }
 return planks;
}
function makeClusterPlanks(body,time,count,target) {
 // In barycentric coordinates, three edge strips λ_i <= a_i leave
 // λ_i > a_i, a translated copy of the body scaled by κ=1-Σa_i.
 // Secondary widths scale by κ too: Σrw = (1-κ) + κ*localBudget.
 const kappa=count===3?1-target:.15,budget=1-kappa;
 const weights=Array.from({length:3},(_,i)=>Math.exp(1.1*Math.sin(time*.09+i*TAU/3)+.2*Math.cos(time*.17+i)));
 const total=weights.reduce((s,x)=>s+x,0),shares=weights.map(w=>budget*w/total),center=[0,0],planks=[];
 for(let i=0;i<3;i++) {
  center[0]+=shares[i]*body[i][0];center[1]+=shares[i]*body[i][1];
  const a=body[(i+1)%3],b=body[(i+2)%3],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length;
  const range=bodyProjection(body,nx,ny);
  planks.push({nx,ny,lo:range.min,hi:range.min+shares[i]*range.width,rw:shares[i]});
 }
 if(count===3)return planks;
 const inner=body.map(p=>[center[0]+kappa*p[0],center[1]+kappa*p[1]]);
 const n=count-3,localBudget=(target-budget)/kappa;
 const cuts=n>=3?makeTighterPlanks(inner,time,n,localBudget):Array.from({length:n},(_,i)=>{
  const angle=time*.08+i*Math.PI/n,nx=Math.cos(angle),ny=Math.sin(angle),range=bodyProjection(inner,nx,ny);
  const rw=localBudget/n,c=(range.min+range.max)/2,half=range.width*rw/2;
  return {nx,ny,lo:c-half,hi:c+half,rw};
 });
 // Measure against the whole body, never against the little cluster.
 for(const p of cuts)planks.push({...p,rw:(p.hi-p.lo)/bodyProjection(body,p.nx,p.ny).width});
 return planks;
}
function makeCapPlanks(body,time,count,target) {
 // For curved bodies, reserve two caps totaling 0.6% of the body's area.
 // A smaller budget can force larger caps; actual uncovered area is displayed.
 const base=.35+time*.018+.1*Math.sin(time*.12)+.14*Math.sin(time*.08),nx=Math.cos(base),ny=Math.sin(base);
 const span=bodyProjection(body,nx,ny),bodyArea=measure(body).area;
 const quantile=q=>{
  let left=span.min,right=span.max;
  for(let i=0;i<25;i++) {
   const mid=(left+right)/2;
   if(measure(clip(body,nx,ny,mid)).area<bodyArea*q)left=mid;else right=mid;
  }
  return (left+right)/2;
 };
 const lower=quantile(.003),upper=quantile(.997),rw=Math.min((upper-lower)/span.width,target-.001);
 const center=(lower+upper)/2,half=rw*span.width/2,main={nx,ny,lo:center-half,hi:center+half,rw};
 const caps=[clip(body,nx,ny,main.lo),clip(body,-nx,-ny,-main.hi)],cuts=[];
 for(let side=0;side<2;side++) {
  const cap=caps[side],n=Math.floor((count-1)/2)+(side<(count-1)%2?1:0);
  for(let family=0;family<2;family++) {
   const m=Math.floor(n/2)+(family<n%2?1:0),angle=base+(family===0?-1:1)*Math.PI/4+.04*Math.sin(time*.13+side+family);
   for(let j=0;j<m;j++) {
    const phase=j*2.3999632297+side*1.1+family*.7,theta=angle+.012*Math.sin(time*.21+phase),cs=Math.cos(theta),sn=Math.sin(theta);
    const local=bodyProjection(cap,cs,sn),whole=bodyProjection(body,cs,sn);
    const f=(j+.5+.24*Math.sin(time*(.3+.004*j)+phase))/m,c=local.min+f*local.width;
    const weight=local.width/whole.width/m*(1+.3*Math.sin(time*.24+phase));
    cuts.push({nx:cs,ny:sn,c,span:whole.width,weight});
   }
  }
 }
 const sum=cuts.reduce((s,p)=>s+p.weight,0),rest=target-main.rw;
 return [main,...cuts.map(p=>{
  const rw=rest*p.weight/sum,h=rw*p.span/2;
  return {nx:p.nx,ny:p.ny,lo:p.c-h,hi:p.c+h,rw};
 })];
}
function findCells(body,planks,reuseUnchanged=false) {
 // Split surviving cells only: no exponential enumeration of 2^n sign strings.
 // In the plane there can be at most 1+n(n+1)/2 surviving components.
 let cells=[{poly:body,code:''}];
 for(const plank of planks) {
  const next=[];
  for(const cell of cells) {
   if(reuseUnchanged) {
    let min=Infinity,max=-Infinity;
    for(const p of cell.poly){const d=plank.nx*p[0]+plank.ny*p[1];min=Math.min(min,d);max=Math.max(max,d);}
    if(min>=plank.lo&&max<=plank.hi)continue;
    const side=max<=plank.lo?'0':min>=plank.hi?'1':null;
    if(side!==null) {
     const stats=cell.area===undefined?measure(cell.poly):{area:cell.area,center:cell.center};
     next.push({poly:cell.poly,code:cell.code+side,...stats});continue;
    }
   }
   const low=clip(cell.poly,plank.nx,plank.ny,plank.lo),high=clip(cell.poly,-plank.nx,-plank.ny,-plank.hi);
   for(const [poly,side] of [[low,'0'],[high,'1']]) {
    if(poly.length<3)continue;
    const stats=measure(poly);
    if(stats.area>AREA_EPSILON)next.push({poly,code:cell.code+side,...stats});
   }
  }
  cells=next;
 }
 return cells;
}

return {clip,measure,bodyProjection,makeBody,makePackedPlanks,makeBudgetPlanks,findCells};
})();

;
'use strict';
(() => {
const G=window.PlankGeometry,B=window.Bireactive,NS='http://www.w3.org/2000/svg',TAU=2*Math.PI;
const reduced=matchMedia('(prefers-reduced-motion:reduce)'),preferredDark=matchMedia('(prefers-color-scheme:dark)'),theme=new EventTarget();
Object.defineProperty(theme,'dark',{get:()=>document.documentElement.dataset.theme==='dark'||document.documentElement.dataset.theme!=='light'&&preferredDark.matches});
Object.defineProperty(theme,'mode',{get:()=>document.documentElement.dataset.theme||'system'});
theme.setMode=mode=>{if(!['system','light','dark'].includes(mode))return;if(mode==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=mode;theme.dispatchEvent(new Event('change'));};
preferredDark.addEventListener('change',()=>theme.dispatchEvent(new Event('change')));
const $=id=>document.getElementById(id),clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const controlScale=host=>host.closest('.presentation-page')?Math.max(1.3,Math.min(innerWidth/1100,innerHeight/750,3)):1;
const diagramTextSize=(host,fallback,dense=false)=>host.closest('.presentation-page')?parseFloat(getComputedStyle(host).fontSize)*(dense?.9:1):fallback;
const colors=['var(--violet)','var(--green)','var(--red)'],fills=['#DBDBFF','#E0FFE0','#FFDDE1'];
const names=['purple','green','red'],parameters=['position','width','angle'];
const symbols=['x','w','θ'],subscripts=['₁','₂','₃'];
const gapColor=()=> 'var(--gap)';
const baseAngles=[0,-132.255044,121.565696].map(x=>x*Math.PI/180);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1],cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
function el(tag,attrs={},parent){const node=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);if(parent)parent.append(node);return node;}
const polygonPath=poly=>poly.length?'M'+poly.map(p=>p.join(',')).join('L')+'Z':'';
const rotate=(p,a)=>[p[0]*Math.cos(a)-p[1]*Math.sin(a),p[0]*Math.sin(a)+p[1]*Math.cos(a)];
const handleMarks={
 move:'M-9 0H9M0-9V9M-6-3L-9 0-6 3M6-3L9 0 6 3M-3-6L0-9 3-6M-3 6L0 9 3 6',
 resize:'M-9 0H9M-6-3L-9 0-6 3M6-3L9 0 6 3',
 rotate:'M7 4A8 8 0 1 1 7-4M1-4H7V-10'
};
function inside(poly,p){return poly.every((a,i)=>{const b=poly[(i+1)%poly.length];return cross([b[0]-a[0],b[1]-a[1]],[p[0]-a[0],p[1]-a[1]])>=-1e-7;});}
function landingBody(){
 const points=[[318.573333,32.64]];
 const curve=(control,end)=>{const start=points.at(-1);for(let i=1;i<=96;i++){const t=i/96,u=1-t;points.push([u*u*start[0]+2*u*t*control[0]+t*t*end[0],u*u*start[1]+2*u*t*control[1]+t*t*end[1]]);}};
 curve([388.333333,0],[328.813333,-24.48]);points.push([-172.146667,-230.52]);
 curve([-231.666667,-255],[-218.466667,-165.24]);points.push([-179.166667,102]);
 curve([-156.666667,255],[55.883333,155.55]);return points.reverse();
}
const originalBody=landingBody(),triangleBody=[[0,-260],[225,130],[-225,130]];
// Seven visible sign cells; the eighth is empty. Keep this independent of the
// first two diagrams and of the preserved three-gap, total-width-one SVG.
const gapBody=[[1165/3,0],[-470/3,255],[-695/3,-255]],gapAngles=[0,Math.atan2(-382.5,-347.5),Math.atan2(382.5,-235)].map(a=>a-.3);
function supportSamples(body,n=240){return Array.from({length:n},(_,i)=>{const a=TAU*i/n,v=[Math.cos(a),Math.sin(a)];return body.reduce((best,p)=>dot(p,v)>dot(best,v)?p:best,body[0]).slice();});}
function plankGeometry({q,body},i){const angle=baseAngles[i]+(q[i*3+2]-.5)*Math.PI,nx=-Math.sin(angle),ny=Math.cos(angle),offset=(q[i*3]-.5)*440,span=G.bodyProjection(body,nx,ny).width,rw=q[i*3+1],width=rw*span;return {angle,nx,ny,offset,width,lo:offset-width/2,hi:offset+width/2,rw,span};}
class PlankModel extends EventTarget {
 constructor(kind){
  super();this.kind=kind;this.playing=false;this.heldPlank=null;
  const body=(kind==='landing'?originalBody:kind==='gaps'?gapBody:triangleBody).map(p=>p.slice()),q=Array.from({length:9},(_,i)=>{const j=Math.floor(i/3);if(kind==='gaps')return i%3===0?.5+50/440:i%3===1?.08:.5+(gapAngles[j]-baseAngles[j])/Math.PI;if(i%3!==1)return .5;const angle=baseAngles[j],span=G.bodyProjection(body,-Math.sin(angle),Math.cos(angle)).width;return (kind==='landing'?[172.197195,192.080028,224.204156][j]:110)/span;});this.initial=q.slice();this.initialBody=body.map(p=>p.slice());
  this.state=B.cell({q,body,dimension:kind==='triangle'?1:9,pristine:true,active:[]},{name:kind+' planks'});
  this.coordinates=B.lens(this.state,s=>s.q,(values,s)=>({...s,q:values.map(x=>clamp(x)),pristine:false}));
  this.parameters=Array.from({length:9},(_,i)=>B.lens(this.state,s=>s.q[i],(value,s)=>({...s,q:s.q.map((x,j)=>j===i?clamp(value):x),pristine:false,active:[i]})));
  this.plankViews=Array.from({length:3},(_,i)=>B.lens(this.state,s=>plankGeometry(s,i),(target,s)=>{
   const current=plankGeometry(s,i),q=s.q.slice(),active=[];
   // Preserve every unedited coordinate exactly, including the other planks.
   for(const [key,j,value]of [['offset',i*3,.5+target.offset/440],['rw',i*3+1,target.rw],['angle',i*3+2,.5+(target.angle-baseAngles[i])/Math.PI]])if(target[key]!==current[key]){q[j]=clamp(value);active.push(j);}
   return {...s,q,pristine:false,active};
  }));
  // Existing renderers receive one coherent snapshot after a reactive update.
  // Their reads are untracked so rendering cannot add accidental dependencies.
  this.dispose=B.effect(()=>{this.state.value;B.untracked(()=>this.dispatchEvent(new Event('change')));});
 }
 get q(){return this.coordinates.value;}
 get body(){return this.state.value.body;}
 get dimension(){return this.state.value.dimension;}
 get pristine(){return this.state.value.pristine;}
 get changed(){return this.q.some((value,i)=>Math.abs(value-this.initial[i])>1e-10)||this.body.length!==this.initialBody.length||this.body.some((p,i)=>p.some((value,j)=>Math.abs(value-this.initialBody[i][j])>1e-8));}
 get active(){return this.state.value.active;}
 get count(){return Math.ceil(this.dimension/3);}
 plank(i){return this.plankViews[i].value;}
 planks(){return Array.from({length:this.count},(_,i)=>this.plank(i));}
 commit(patch){B.batch(()=>{this.state.value={...this.state.value,...patch};});}
 emit(active=[]){this.commit({active});}
 editCoordinates(write){B.batch(()=>{
  const before=this.q;write();
  // Manual edits shift the running motion instead of being overwritten by it.
  if(this.playing)this.q.forEach((value,i)=>{if(value!==before[i]&&Math.floor(i/3)!==this.heldPlank?.i)this.motionBase[i]=value-this.motionDelta(i);});
  if(this.heldPlank)this.heldPlank.plank=this.plank(this.heldPlank.i);
 });}
 setQ(values,active=[]){this.editCoordinates(()=>{this.coordinates.value=values;this.state.value={...this.state.value,active};});}
 setParameter(i,value){this.editCoordinates(()=>{this.parameters[i].value=value;});}
 setPlank(i,patch){this.editCoordinates(()=>{const view=this.plankViews[i];view.value={...view.value,...patch};});}
 holdPlank(i){this.heldPlank={i,plank:this.plank(i),q:this.q.slice(i*3,i*3+3),motionBase:this.playing?this.motionBase:null};}
 releasePlank(cancel=false){
  const held=this.heldPlank;if(!held)return;this.heldPlank=null;
  const q=this.q.slice(),restoreMotion=cancel&&this.playing&&held.motionBase===this.motionBase;
  for(let j=0;j<3;j++){const i=held.i*3+j;if(cancel)q[i]=restoreMotion?clamp(this.motionBase[i]+this.motionDelta(i)):held.q[j];if(this.playing&&!restoreMotion)this.motionBase[i]=q[i]-this.motionDelta(i);}
  this.commit({q,active:[]});
 }
 motionDelta(i){return (.025+.018*(i%3))*(Math.sin(this.motionTime*(.12+.025*(i%3))+i*1.3)-Math.sin(i*1.3));}
 setDimension(n){this.commit({dimension:n,active:[]});}
 stop(){this.playing=false;this.dispatchEvent(new Event('playchange'));}
 start(){this.motionBase=this.q.slice();this.motionBody=supportSamples(this.body);this.motionTime=0;this.playing=true;this.commit({pristine:false});this.dispatchEvent(new Event('playchange'));}
 reset(){this.stop();this.heldPlank=null;this.commit({q:this.initial.slice(),body:this.initialBody.map(p=>p.slice()),pristine:true,active:[]});}
 tick(dt){
  if(!this.playing)return;this.motionTime+=dt;
  const t=this.motionTime,bodyTime=t*.65,angle=.1*Math.sin(bodyTime*.12)+bodyTime*.018,mix=(1-Math.cos(t*.25))/2;
  // Undo the target's rotation to match outward normals before the Minkowski
  // blend. Apply a common rotation afterwards; convexity is preserved.
  const target=G.makeBody(bodyTime,'morph').map(p=>rotate(p,-angle));
  const body=this.motionBody.map((p,i)=>rotate([(1-mix)*p[0]+mix*target[i][0]*190,(1-mix)*p[1]+mix*target[i][1]*190],angle*mix)),q=this.motionBase.map((q,i)=>clamp(q+this.motionDelta(i)));
  if(this.heldPlank){
   // Hold world-space bounds, including width, while the body changes beneath
   // the pointer. Relative width follows the body's current support span.
   const {i,plank:p}=this.heldPlank;q[i*3]=clamp(.5+p.offset/440);q[i*3+1]=clamp(p.width/G.bodyProjection(body,p.nx,p.ny).width);q[i*3+2]=clamp(.5+(p.angle-baseAngles[i])/Math.PI);
  }
  this.commit({body,q,active:this.heldPlank?this.active:[]});
 }
}
let diagramId=0;
class PlankDiagram {
 constructor(host,model,{detailed=false,cellColors=false,cellLabels=false,showGaps=true,artwork=null,percentageDigits=0}={}){this.host=host;this.model=model;this.detailed=detailed;this.cellColors=cellColors;this.cellLabels=cellLabels;this.showGaps=showGaps;this.artwork=artwork;this.percentageDigits=percentageDigits;this.selectedCell=null;this.id='pw'+(++diagramId);this.hint=null;this.drag=null;this.frame=null;this.hoverPoint=null;model.addEventListener('change',()=>this.render());this.render();host.addEventListener('pointerdown',e=>this.down(e));host.addEventListener('pointermove',e=>this.move(e));host.addEventListener('pointerenter',e=>this.hover(e));host.addEventListener('pointerleave',()=>{if(!this.drag){this.hoverPoint=null;this.updateHover();}});host.addEventListener('pointerup',e=>this.up(e));host.addEventListener('pointercancel',()=>this.cancel());host.addEventListener('lostpointercapture',e=>this.up(e));host.addEventListener('keydown',e=>this.key(e));host.addEventListener('focusout',e=>e.target.closest('.handle')?.classList.remove('pointer-focused'));new ResizeObserver(()=>{if(host.clientWidth&&host.clientHeight)this.render();}).observe(host);}
 render(){
  const previous=this.animatePlankChanges&&!reduced.matches&&this.frame&&this.frame.planks.length!==this.model.count?{svg:this.svg.cloneNode(true),count:this.frame.planks.length}:null;
  const active=this.host.contains(document.activeElement)?document.activeElement.closest('[data-kind]'):null;
  const focused=active?{...active.dataset,pointerFocus:active.classList.contains('pointer-focused')}:null;
  const m=this.model,body=m.body,planks=m.planks(),cells=G.findCells(body,planks,true);this.frame={body,planks,cells,bodyArea:G.measure(body).area};
  if(this.detailed&&m.pristine){this.host.innerHTML=(this.artwork||window.PlankArtwork).replaceAll('id="','id="'+this.id+'-').replaceAll('url(#','url(#'+this.id+'-').replaceAll('href="#','href="#'+this.id+'-');this.svg=this.host.querySelector('svg');this.svg.setAttribute('viewBox','-504 -560 1149 1070');this.scene=this.svg.querySelector(':scope > g');}
  else {
   this.host.replaceChildren();this.svg=el('svg',{viewBox:this.detailed?'-504 -560 1149 1070':m.kind==='gaps'?'-390 -340 840 680':'-360 -310 720 610',role:'img','aria-label':`${m.count} planks and their actual uncovered cells`},this.host);
   const defs=el('defs',{},this.svg);this.scene=el('g',{transform:'rotate(12)'},this.svg);
   if(this.detailed){const dotted=el('g',{class:'plank-measurements',fill:'none',stroke:'var(--grid)','stroke-width':1.4,'stroke-linecap':'round','stroke-dasharray':'1 8'},this.scene);planks.forEach((p,i)=>{const r=G.bodyProjection(body,p.nx,p.ny),[start,end]=this.ends(i);el('path',{transform:`rotate(${p.angle*180/Math.PI})`,d:`M${start} ${r.min}H${end+20}M${start} ${r.max}H${end+20}`},dotted);});}
   const plankBorders=[];
   planks.forEach((p,i)=>{
    const [start,end]=this.ends(i),grad=this.id+'-fade'+i,mask=this.id+'-mask'+i;
    const gradient=el('linearGradient',{id:grad,gradientUnits:'userSpaceOnUse',x1:start,y1:0,x2:end,y2:0},defs);
    for(const [offset,opacity]of [[0,0],[.11,1],[.89,1],[1,0]])el('stop',{offset,'stop-color':'white','stop-opacity':opacity},gradient);
    const maskNode=el('mask',{id:mask,maskUnits:'userSpaceOnUse',x:start-3,y:-p.width/2-3,width:end-start+6,height:p.width+6,style:'mask-type:alpha'},defs);
    el('rect',{x:start-3,y:-p.width/2-3,width:end-start+6,height:p.width+6,fill:`url(#${grad})`},maskNode);
    const group=el('g',{transform:`rotate(${p.angle*180/Math.PI}) translate(0 ${p.offset})`,class:'plank-strip','data-plank':i},this.scene),masked=el('g',{mask:`url(#${mask})`},group);
    el('rect',{x:start,y:-p.width/2,width:end-start,height:p.width,fill:fills[i]},masked);
    // Keep gap fills beneath the complete border, including its inner half.
    const borderGroup=el('g',{transform:group.getAttribute('transform'),class:'plank-strip','data-plank':i});
    const borderMask=el('g',{mask:`url(#${mask})`},borderGroup);
    el('path',{d:`M${start} ${-p.width/2}H${end}M${start} ${p.width/2}H${end}`,fill:'none',stroke:colors[i],'stroke-width':2},borderMask);
    plankBorders.push(borderGroup);
   });
   if(this.showGaps)for(const cell of cells){const color=this.cellColors?`var(--cell-${parseInt(cell.code,2)})`:gapColor(cell.code);el('path',{d:polygonPath(cell.poly),fill:color,stroke:this.cellColors?color:'var(--gap-edge)','stroke-width':.65,'vector-effect':'non-scaling-stroke','pointer-events':'none','data-cell':cell.code},this.scene);}
   this.scene.append(...plankBorders);
   el('path',{d:polygonPath(body),fill:'none',stroke:'var(--ink)','stroke-width':2.6,'stroke-linejoin':'round',class:'body-outline'},this.scene);
   if(this.cellLabels)for(const cell of cells){
    const at=cell.center,index=parseInt(cell.code,2),color=`var(--cell-${index})`;
    const label=el('text',{x:at[0],y:at[1],transform:`rotate(-12 ${at[0]} ${at[1]})`,'text-anchor':'middle','dominant-baseline':'central',fill:color,class:'gap-cell-label','data-gap-label':cell.code,'pointer-events':'none'},this.scene);
    label.textContent='g'+'₀₁₂₃₄₅₆₇'[index];
   }
   if(this.detailed)planks.forEach((p,i)=>{const r=G.bodyProjection(body,p.nx,p.ny),end=this.ends(i)[1],group=el('g',{class:'plank-measurements',transform:`rotate(${p.angle*180/Math.PI})`},this.scene);const dimension=(lo,hi,color,w)=>el('path',{d:`M${end} ${lo}V${hi}M${end-12} ${lo}H${end+12}M${end-12} ${hi}H${end+12}`,fill:'none',stroke:color,'stroke-width':w,'stroke-linecap':'butt'},group);dimension(r.min,r.max,'var(--ink)',2);dimension(p.lo,p.hi,colors[i],3);const flip=Math.cos(p.angle+12*Math.PI/180)<0,tx=end+26,ty=flip?-14:14;const text=el('text',{x:tx,y:ty,transform:flip?`rotate(180 ${tx} ${ty})`:'','text-anchor':flip?'end':'start','font-family':'Latin Modern Roman, Computer Modern, serif','font-size':42,fill:colors[i]},group);text.textContent=new Intl.NumberFormat('en',{style:'percent',maximumFractionDigits:this.percentageDigits}).format(p.rw);});
  }
  for(const strip of this.svg.querySelectorAll('g[style*="mix-blend-mode"]')){strip.classList.add('plank-strip');strip.style.removeProperty('mix-blend-mode');}
  this.svg.setAttribute('role','group');
  if(this.detailed&&m.pristine&&this.svg.hasAttribute('aria-labelledby'))this.svg.setAttribute('aria-labelledby',this.svg.getAttribute('aria-labelledby').split(/\s+/).map(id=>this.id+'-'+id).join(' '));
  // SVG geometry scales with the figure; its text must remain readable when
  // the figure is small. Use the presentation's label size in screen pixels.
  if(this.host.closest('.presentation-page')){
   const matrix=this.scene.getScreenCTM(),scale=matrix&&Math.hypot(matrix.a,matrix.b),style=getComputedStyle(this.host),size=parseFloat(style.fontSize);
   if(scale>0)for(const label of this.svg.querySelectorAll(this.detailed?'text':'.gap-cell-label')){
    label.style.fontSize=size/scale+'px';label.style.fontFamily=style.fontFamily;
    if(label.classList.contains('gap-cell-label'))label.style.strokeWidth=3/scale+'px';
   }
  }
  this.addHandles();
  this.highlightCell(this.selectedCell);
  if(focused){
   const group=this.handles.find(h=>h.i===Number(focused.plank)&&h.kind===focused.kind&&h.side===Number(focused.side))?.group;
   // Replacing SVG nodes can promote programmatic focus to :focus-visible.
   // Keep mouse focus quiet across redraws; real keyboard input reveals it.
   if(group){group.classList.toggle('pointer-focused',focused.pointerFocus);group.focus({preventScroll:true});}
  }
  this.host.dispatchEvent(new CustomEvent('geometrychange',{detail:this.frame}));
  if(previous)this.fadePlankChange(previous);
 }
 fadePlankChange({svg,count}){
  // Keep the body and surviving strips still. Crossfade the actual old/new
  // gap polygons, plus just the strips that enter or leave the configuration.
  const timing={duration:700,easing:'cubic-bezier(.22,.65,.3,1)'};
  for(const node of this.svg.querySelectorAll('[data-cell],.plank-strip'))if(node.hasAttribute('data-cell')||Number(node.dataset.plank)>=count)node.animate([{opacity:0},{opacity:1}],timing);
  svg.querySelectorAll('.body-outline,.handle,[data-gap-label]').forEach(node=>node.remove());
  for(const node of svg.querySelectorAll('.plank-strip'))if(Number(node.dataset.plank)<this.model.count)node.remove();
  // The passive snapshot needs its own mask and gradient IDs.
  svg.innerHTML=svg.innerHTML.replaceAll(this.id+'-',this.id+'-departing-');
  svg.classList.add('plank-transition-overlay');svg.setAttribute('aria-hidden','true');svg.setAttribute('role','presentation');
  this.host.append(svg);
  svg.animate([{opacity:1},{opacity:0}],{...timing,fill:'forwards'}).finished.then(()=>svg.remove()).catch(()=>{});
 }
 ends(i){return this.detailed?[[-346,482],[-370,437],[-320,351]][i]:this.model.kind==='gaps'?[[-357,514],[-387,470],[-329,425]][i]:[-340,340];}
 highlightCell(code){this.selectedCell=code;for(const node of this.svg.querySelectorAll('[data-cell],[data-gap-label]'))node.classList.toggle('gap-selected',(node.dataset.cell||node.dataset.gapLabel)===code);}
 handleCenter(p,i){const u=[Math.cos(p.angle),Math.sin(p.angle)],n=[p.nx,p.ny],t=[-110,105,-95][i];return [u[0]*t+n[0]*p.offset,u[1]*t+n[1]*p.offset];}
 addHandles(){
  const m=this.model,layer=el('g',{'aria-label':'Plank controls'},this.scene),matrix=this.scene.getScreenCTM();
  const displayScale=controlScale(this.host);
  const pixel=displayScale/Math.max(.05,Math.hypot(matrix.a,matrix.b)),hitRadius=22*pixel;this.handleHitPixels=22*displayScale;this.handles=[];
  m.planks().forEach((p,i)=>{
   const u=[Math.cos(p.angle),Math.sin(p.angle)],n=[p.nx,p.ny],at=(t,d)=>[u[0]*t+n[0]*d,u[1]*t+n[1]*d];
   const specs=[['move',this.handleCenter(p,i),0,0],['resize',at(0,p.lo),1,-1],['resize',at(0,p.hi),1,1],['rotate',at(-270,p.offset),2,-1],['rotate',at(270,p.offset),2,1]];
   for(const [kind,pos,k,side]of specs){if(i*3+k>=m.dimension)continue;
    const group=el('g',{transform:`translate(${pos[0]} ${pos[1]})`,class:'handle'+(this.hint==='all'||this.hint===kind?' revealed':'')+(this.drag?.i===i&&this.drag?.kind===kind?' dragging':''),style:`color:${colors[i]}`,'data-kind':kind,'data-plank':i,'data-side':side,tabindex:0,role:'button','aria-label':`${kind} ${names[i]} plank; use arrow keys`},layer);
    this.handles.push({group,pos,kind,i,side});el('circle',{r:hitRadius,class:'handle-hit'},group);const visible=el('g',{class:'handle-visible',transform:`scale(${pixel})`},group);
    const markAngle=p.angle*180/Math.PI+(kind==='resize'?90:kind==='rotate'&&side>0?180:0);
    el('path',{d:handleMarks[kind],class:'handle-mark',transform:`rotate(${markAngle})`},visible);
   }
  });
  this.updateHover();
 }
 hover(e){this.hoverPoint=[e.clientX,e.clientY];this.updateHover();}
 updateHover(){
  const matrix=this.scene.getScreenCTM();if(!matrix)return;
  const hovered=new Set();
  if(this.drag)hovered.add(this.drag.i);
  else if(this.hoverPoint){
   const p=new DOMPoint(...this.hoverPoint).matrixTransform(matrix.inverse()),point=[p.x,p.y],slop=2/Math.hypot(matrix.a,matrix.b);
   this.model.planks().forEach((plank,i)=>{const along=dot(point,[Math.cos(plank.angle),Math.sin(plank.angle)]),across=dot(point,[plank.nx,plank.ny]),[start,end]=this.ends(i);if(along>=start-slop&&along<=end+slop&&across>=plank.lo-slop&&across<=plank.hi+slop)hovered.add(i);});
   // Keep a revealed control usable across its full hit target, including
   // the part of a resize handle that extends outside the plank itself.
   for(const h of this.handles)if(this.hoveredPlanks?.has(h.i)){const p=new DOMPoint(...h.pos).matrixTransform(matrix);if(Math.hypot(p.x-this.hoverPoint[0],p.y-this.hoverPoint[1])<=this.handleHitPixels)hovered.add(h.i);}
  }
  this.hoveredPlanks=hovered;
  for(const h of this.handles)h.group.classList.toggle('plank-hovered',hovered.has(h.i));
  let nearest=null,best=Infinity;
  if(this.drag)nearest=this.handles.find(h=>h.i===this.drag.i&&h.kind===this.drag.kind&&h.side===this.drag.side);
  else if(this.hoverPoint)for(const h of this.handles)if(hovered.has(h.i)){const p=new DOMPoint(...h.pos).matrixTransform(matrix),distance=Math.hypot(p.x-this.hoverPoint[0],p.y-this.hoverPoint[1]);if(distance<best){best=distance;nearest=h;}}
  this.nearest=nearest;for(const h of this.handles)h.group.classList.toggle('nearest',h===nearest);
  if(nearest)this.host.style.cursor=this.drag?'grabbing':'grab';
  else this.host.style.cursor='';
 }
 world(e){const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(this.scene.getScreenCTM().inverse());return [p.x,p.y];}
 down(e){if(e.button!==0||this.drag)return;this.hover(e);const h=this.nearest;if(!h)return;e.preventDefault();const i=h.i,p=this.model.plank(i);this.drag={i,kind:h.kind,side:h.side,start:this.world(e),p,pivot:[0,0],pointer:e.pointerId};this.model.holdPlank(i);this.host.setPointerCapture(e.pointerId);h.group.classList.add('pointer-focused');h.group.focus({preventScroll:true});h.group.classList.add('dragging');this.updateHover();}
 move(e){this.hover(e);if(!this.drag||e.pointerId!==this.drag.pointer)return;e.preventDefault();const d=this.drag,p=this.world(e),delta=[p[0]-d.start[0],p[1]-d.start[1]],n=[d.p.nx,d.p.ny],patch={};
  if(d.kind==='move')patch.offset=d.p.offset+dot(delta,n);
  if(d.kind==='resize')patch.rw=(d.p.width+2*d.side*dot(delta,n))/this.model.plank(d.i).span;
  // x is the signed normal offset from the origin. Turning about that origin
  // keeps x fixed, so the rotator edits only the angle, like its slider.
  if(d.kind==='rotate'){const a=Math.atan2(p[1]-d.pivot[1],p[0]-d.pivot[0])-Math.atan2(d.start[1]-d.pivot[1],d.start[0]-d.pivot[0]),turn=Math.atan2(Math.sin(a),Math.cos(a)),qAngle=clamp(.5+(d.p.angle+turn-baseAngles[d.i])/Math.PI);patch.angle=baseAngles[d.i]+(qAngle-.5)*Math.PI;}
  this.model.setPlank(d.i,patch);
 }
 up(e){if(!this.drag||e.pointerId!==this.drag.pointer)return;const id=this.drag.pointer;this.drag=null;if(this.host.hasPointerCapture(id))this.host.releasePointerCapture(id);this.model.releasePlank();}
 cancel(){if(!this.drag)return;const id=this.drag.pointer;this.drag=null;if(this.host.hasPointerCapture(id))this.host.releasePointerCapture(id);this.model.releasePlank(true);}
 key(e){e.target.closest('.handle')?.classList.remove('pointer-focused');if(e.key==='Escape'){this.cancel();return;}const h=e.target.closest('[data-kind]');if(!h||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const i=Number(h.dataset.plank)*3+{move:0,resize:1,rotate:2}[h.dataset.kind],sign=['ArrowRight','ArrowUp'].includes(e.key)?1:-1;this.model.setParameter(i,this.model.q[i]+sign*(e.shiftKey?.002:.012));const next=this.host.querySelector(`[data-plank="${h.dataset.plank}"][data-kind="${h.dataset.kind}"][data-side="${h.dataset.side}"]`);next?.focus({preventScroll:true});}
 setHint(kind){this.hint=kind;for(const h of this.host.querySelectorAll('[data-kind]'))h.classList.toggle('revealed',kind==='all'||h.dataset.kind===kind);}
 bindHints(root){
  const show=kind=>this.setHint(kind),hide=()=>this.setHint(null);
  for(const button of root.querySelectorAll('[data-plank-hint],.intro-plank-hint')){
   const kind=button.dataset.plankHint||'all';
   for(const event of ['pointerenter','focus'])button.addEventListener(event,()=>show(kind));
   for(const event of ['pointerleave','blur'])button.addEventListener(event,hide);
   button.addEventListener('click',event=>{show(kind);if(event.detail===0)this.handles.find(h=>kind==='all'||h.kind===kind)?.group.focus({preventScroll:true});});
  }
 }
}
function projectedBasis(d,tilted=false,width=500,height=400,grouping='property'){
 const primary=tilted?[330,210,90]:[0,90,225];
 const groups=Array.from({length:d},(_,i)=>d<=3?i:grouping==='property'?i%3:Math.floor(i/3));
 const counts=Array.from({length:3},(_,group)=>groups.filter(g=>g===group).length);
 const vectors=groups.map((group,i)=>{
  const rank=d<=3?0:grouping==='property'?Math.floor(i/3):i%3;
  // Property grouping keeps each existing direction and relative length fixed:
  // a new dimension extrudes the old box instead of turning it inside out.
  const spread=grouping==='property'?[0,18,-18][rank]:(rank-(counts[group]-1)/2)*18;
  const angle=(primary[group]+spread)*Math.PI/180;
  const length=(tilted||group!==2?1:.5)/(grouping==='property'?1:Math.sqrt(counts[group]));
  return [Math.cos(angle)*length,-Math.sin(angle)*length];
 });
 const sx=vectors.reduce((s,v)=>s+Math.abs(v[0]),0),sy=vectors.reduce((s,v)=>s+Math.abs(v[1]),0);
 const scale=Math.min((width-100)/Math.max(1,sx),(height-90)/Math.max(.1,sy));
 return Array.from({length:9},(_,i)=>i<d?vectors[i].map(x=>x*scale):[0,0]);
}
const axisError=(a,b)=>Math.atan2(Math.abs(cross(a,b)),Math.abs(dot(a,b)));
function dominantAxis(delta,basis,diagonalBias=0){
 let axis=null,best=Infinity;
 basis.forEach((v,i)=>{if(Math.hypot(...v)<1e-5)return;const error=axisError(delta,v)-(i===2?diagonalBias:0);if(error<best){best=error;axis=i;}});
 return axis;
}
function axisOrientation(v){const length2=dot(v,v);return [(v[0]*v[0]-v[1]*v[1])/length2,2*v[0]*v[1]/length2];}
function stableSnapAxis(delta,basis,state,diagonalBias=0){
 // Average unoriented directions over about four pixels of travel. Reversing
 // along an axis has the same orientation, so it does not cancel the filter.
 const distance=Math.hypot(...delta),orientation=axisOrientation(delta),weight=-Math.expm1(-distance/4);
 state.direction=state.direction?state.direction.map((x,i)=>x+(orientation[i]-x)*weight):orientation;
 if(Math.hypot(...state.direction)<.05)return state.axis;
 const angle=Math.atan2(state.direction[1],state.direction[0])/2,direction=[Math.cos(angle),Math.sin(angle)],candidate=dominantAxis(direction,basis,diagonalBias);
 if(state.axis===null){state.axis=candidate;return candidate;}
 const error=i=>axisError(direction,basis[i])-(i===2?diagonalBias:0);
 const separation=axisError(basis[state.axis],basis[candidate]);
 // Keep a narrow overlap between windows; scale it down for crowded axes.
 const margin=Math.min(4*Math.PI/180,separation*.2);
 if(candidate===state.axis||candidate!==dominantAxis(delta,basis,diagonalBias)||error(state.axis)-error(candidate)<=margin){state.candidate=null;state.travel=0;return state.axis;}
 if(state.candidate!==candidate){state.candidate=candidate;state.travel=0;}
 state.travel+=distance;
 if(state.travel>=3){state.axis=candidate;state.candidate=null;state.travel=0;}
 return state.axis;
}
function directionalDelta(delta,basis,lockedAxis=null){
 // Exact screen displacement lifted through the two adjacent projected rays.
 const result=Array(9).fill(0),available=basis.map((v,i)=>({v,i,length:Math.hypot(...v)})).filter(x=>x.length>1e-5);
 if(!available.length||Math.hypot(...delta)<1e-9)return result;
 if(lockedAxis!==null||available.length===1){const item=available.find(x=>x.i===lockedAxis)||available[0];result[item.i]=dot(delta,item.v)/(item.length*item.length);return result;}
 const rays=available.flatMap(({v,i,length})=>[1,-1].map(sign=>({v:v.map(x=>x/length*sign),i,length,sign,angle:(Math.atan2(v[1]*sign,v[0]*sign)+TAU)%TAU}))).sort((a,b)=>a.angle-b.angle);
 const a=(Math.atan2(delta[1],delta[0])+TAU)%TAU;
 let right=rays.findIndex(r=>r.angle>a);if(right<0)right=0;const left=(right+rays.length-1)%rays.length,r=rays[right],l=rays[left],det=cross(l.v,r.v);
 if(Math.abs(det)<1e-7){const closest=available.reduce((best,x)=>Math.abs(dot(delta,x.v)/x.length)>Math.abs(dot(delta,best.v)/best.length)?x:best);result[closest.i]=dot(delta,closest.v)/(closest.length*closest.length);return result;}
 result[l.i]+=cross(delta,r.v)/det*l.sign/l.length;result[r.i]+=cross(l.v,delta)/det*r.sign/r.length;return result;
}
class ParameterSpace {
 constructor(host,model){
  this.host=host;this.model=model;this.dimension=model.dimension;this.width=500;this.height=400;this.grouping='property';this.basis=projectedBasis(this.dimension);this.rule='snap';this.tilted=false;this.cube=true;this.drag=null;this.transition=null;
  model.addEventListener('change',()=>this.update());this.build();
  host.addEventListener('pointerdown',e=>this.down(e));host.addEventListener('pointermove',e=>this.move(e));host.addEventListener('pointerup',()=>this.up());host.addEventListener('pointercancel',()=>this.cancel());host.addEventListener('keydown',e=>this.key(e));
  new ResizeObserver(()=>this.resize()).observe(host);
 }
 resize(){const w=this.host.clientWidth,h=this.host.clientHeight;if(w<10||h<10||w===this.width&&h===this.height)return;const old=this.basis,target=projectedBasis(this.dimension,this.tilted,w,h,this.grouping);this.width=w;this.height=h;this.basis=target;if(this.transition){this.transition.from=target.map((v,i)=>old[i].map((x,j)=>x));this.transition.target=target;}this.build();}
 project(q){return this.basis.reduce((p,v,i)=>[p[0]+v[0]*(q[i]-.5),p[1]+v[1]*(q[i]-.5)],[this.width/2,this.height/2]);}
 setDimension(d){const changed=d!==this.dimension;if(changed)this.guidePlank=Math.floor((d-1)/3);this.renderDimension=Math.max(d,this.renderDimension||this.dimension);this.dimension=d;this.transition={start:performance.now(),duration:changed?850:650,from:this.basis.map(v=>v.slice()),target:projectedBasis(d,this.tilted&&d>=3,this.width,this.height,this.grouping)};if(reduced.matches)this.tick(Infinity);}
 tick(now){if(!this.transition)return;const t=clamp((now-this.transition.start)/this.transition.duration),s=t*t*(3-2*t);this.basis=this.transition.from.map((v,i)=>v.map((x,j)=>x+(this.transition.target[i][j]-x)*s));if(t===1){this.transition=null;this.renderDimension=this.dimension;}this.build();}
 build(){
  const focused=this.host.querySelector('.space-point')===document.activeElement;
  this.host.replaceChildren();this.svg=el('svg',{viewBox:`0 0 ${this.width} ${this.height}`,role:'group','aria-label':`${this.dimension}-parameter configuration space`},this.host);
  const d=this.renderDimension||this.dimension,vertices=Array.from({length:1<<d},(_,mask)=>this.project(Array.from({length:9},(_,i)=>i<d?((mask>>i)&1):.5)));
  this.axisPaths=[];
  for(let i=0;i<d;i++){
   if(Math.hypot(...this.basis[i])<.01)continue;
   let path='';for(let mask=0;mask<(1<<d);mask++)if(!(mask&(1<<i))){const a=vertices[mask],b=vertices[mask|(1<<i)];path+=`M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${b[0].toFixed(2)} ${b[1].toFixed(2)}`;}
   const opacity=this.cube?(d<=3?.5:Math.max(.13,.36-(d-4)*.045)):0;
   this.axisPaths[i]=el('path',{d:path,fill:'none',stroke:colors[Math.floor(i/3)],'stroke-width':this.cube?1.15:.7,opacity,'data-axis':i},this.svg);
  }
  if(d===1)for(let j=1;j<8;j++){
   const q=Array(9).fill(.5);q[0]=j/8;const p=this.project(q);el('path',{d:`M${p[0]} ${p[1]-5}V${p[1]+5}`,stroke:colors[0],'stroke-width':1,opacity:.25},this.svg);
  }
  // Subdivide every coordinate face through the origin, in all dimensions.
  // Fade a face in as its new axis grows, avoiding stacked lines at zero size.
  for(let i=0;i<d;i++)for(let k=0;k<d;k++)if(k!==i){
   const presence=clamp(Math.min(Math.hypot(...this.basis[i]),Math.hypot(...this.basis[k]))/32);if(!presence)continue;
   const a=Array.from({length:9},(_,l)=>l<d?0:.5),b=a.slice();b[k]=1;let path='';
   for(let j=1;j<8;j++){a[i]=b[i]=j/8;path+=`M${this.project(a)}L${this.project(b)}`;}
   el('path',{d:path,fill:'none',stroke:colors[Math.floor(k/3)],'stroke-width':.65,opacity:.11*presence,'data-grid-line':true,'data-grid-axis':k,'data-grid-fixed-axis':i},this.svg);
  }
  const origin=this.axisOrigin=this.project(Array.from({length:9},(_,i)=>i<d?0:.5)),labelSize=diagramTextSize(this.host,d>3?14:16,d>3);
  for(let i=0;i<d;i++){
   const v=this.basis[i],length=Math.hypot(...v);if(length<3)continue;
   const unit=v.map(x=>x/length),a=origin,b=origin.map((x,j)=>x+v[j]),tip=b.map((x,j)=>x+unit[j]*22),c=colors[Math.floor(i/3)];
   el('path',{d:`M${a}L${tip}M${tip[0]-unit[0]*9-unit[1]*4} ${tip[1]-unit[1]*9+unit[0]*4}L${tip}L${tip[0]-unit[0]*9+unit[1]*4} ${tip[1]-unit[1]*9-unit[0]*4}`,fill:'none',stroke:c,'stroke-width':1.6,opacity:.8,'data-primary-axis':i},this.svg);
   const text=el('text',{x:clamp(tip[0]+unit[0]*14,18,this.width-labelSize*(d>3?1.2:.65)-4),y:clamp(tip[1]+unit[1]*14+4-(i%3===1?labelSize*.7:0),labelSize*(i%3===1?.6:1),this.height-5),'text-anchor':unit[0]>.3?'start':unit[0]<-.3?'end':'middle','font-size':labelSize,fill:c,'data-axis-symbol':i},this.svg);
   text.textContent=symbols[i%3]+(d>3?subscripts[Math.floor(i/3)]:'');
   const title=el('title',{},text);title.textContent=`${d>3?names[Math.floor(i/3)]+' ':''}${i%3===1?'relative width':parameters[i%3]}`;
  }
  this.axisGuides=el('g',{'pointer-events':'none'},this.svg);
  this.point=el('g',{class:'space-point',tabindex:0,role:'button','aria-label':'Configuration point. Drag, or use arrow keys; Shift changes angle.'},this.svg);
  const pointScale=controlScale(this.host);
  el('path',{class:'space-point-hint',d:handleMarks[this.dimension===1?'resize':'move'],transform:`scale(${2.4*pointScale})`,fill:'none',stroke:'var(--ink)','stroke-width':.8,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'},this.point);
  el('circle',{r:24*pointScale,fill:'transparent'},this.point);el('circle',{r:9*pointScale,fill:'var(--ink)',stroke:'var(--page)','stroke-width':3*pointScale},this.point);
  this.update();if(focused)this.point.focus();
 }
 update(){
  if(!this.point)return;const p=this.project(this.model.q);this.point.setAttribute('transform',`translate(${p})`);this.axisGuides.replaceChildren();
  const active=(this.model.active||[]).filter(i=>i<this.dimension);for(const axis of this.svg.querySelectorAll('[data-primary-axis]')){const on=active.includes(Number(axis.dataset.primaryAxis));axis.setAttribute('stroke-width',on?2.5:1.6);axis.setAttribute('opacity',on?1:.8);}
  this.drawGuides(p,active);
  const feedback=$('dragFeedback'),limited=this.drag?.limited||[];if(feedback)feedback.textContent=limited.length?limited.map(i=>`${this.dimension>3?names[Math.floor(i/3)]+' ':''}${parameters[i%3]} limit`).join(' · '):active.length?active.map(i=>`${this.dimension>3?names[Math.floor(i/3)]+' ':''}${parameters[i%3]}`).join(' + '):'Drag the point or a plank.';
 }
 setHint(show){this.host.classList.toggle('show-point-hint',show);}
 drawGuides(point,active){
  const size=diagramTextSize(this.host,this.dimension>3?14:16,this.dimension>3);
  if(active.length)this.guidePlank=Math.floor(active[0]/3);
  const plank=Math.min(this.guidePlank||0,Math.ceil(this.dimension/3)-1),first=plank*3,q=this.model.q,faceLinks=el('g',{stroke:colors[plank],'stroke-width':1,'stroke-dasharray':'3 4',opacity:.42},this.axisGuides),lines=el('g',{},this.axisGuides),labels=el('g',{},this.axisGuides),placed=[];
  for(let i=first;i<Math.min(first+3,this.dimension);i++){
   const v=this.basis[i],length=Math.hypot(...v);if(length<3)continue;
   const foot=this.axisOrigin.map((x,j)=>x+q[i]*v[j]),unit=v.map(x=>x/length),normal=[-unit[1],unit[0]],c=colors[plank];
   // Drop only this coordinate to reach its zero face. The guide is normal
   // to that face in parameter space and parallel to this projected axis.
   // Keep the value label and tick at their position on the axis itself.
   const faceQ=q.slice();faceQ[i]=0;const face=this.project(faceQ);
   for(let j=first;j<Math.min(first+3,this.dimension);j++)if(j!==i){
    const axis=this.axisOrigin.map((x,k)=>x+q[j]*this.basis[j][k]);
    if(Math.hypot(face[0]-axis[0],face[1]-axis[1])>.1)el('line',{x1:axis[0],y1:axis[1],x2:face[0],y2:face[1],'data-face-link':`${j}:${i}`},faceLinks);
   }
   if(dot(normal,point.map((x,j)=>x-foot[j]))>0)normal.forEach((x,j)=>normal[j]=-x);
   el('line',{x1:point[0],y1:point[1],x2:face[0],y2:face[1],stroke:c,'stroke-width':1,'stroke-dasharray':'3 4',opacity:.42,'data-guide-axis':i},lines);
   el('path',{d:`M${foot[0]-normal[0]*4} ${foot[1]-normal[1]*4}L${foot[0]+normal[0]*4} ${foot[1]+normal[1]*4}`,stroke:c,'stroke-width':1.2},lines);
   const value=i%3===2?Math.round(this.model.plank(plank).angle*180/Math.PI)+'°':(i%3===0?(q[i]-.5)*2:q[i]).toFixed(2),text=symbols[i%3]+(this.dimension>3?subscripts[plank]:'')+' = '+value,halfWidth=text.length*size*.3;
   // Start just outside the tick. Account for the label's rectangular bounds
   // along the outward ray instead of adding its width to every offset.
   const labelExtent=Math.min(Math.abs(normal[0])>1e-6?halfWidth/Math.abs(normal[0]):Infinity,Math.abs(normal[1])>1e-6?size*.6/Math.abs(normal[1]):Infinity);
   let center,box;
   for(let distance=10;distance<=145;distance+=Math.max(18,size+4)){
    center=foot.map((x,j)=>x+normal[j]*(distance+labelExtent));center[0]=clamp(center[0],halfWidth+5,this.width-halfWidth-5);center[1]=clamp(center[1],size*.75+4,this.height-size*.75-4);
    box={left:center[0]-halfWidth-4,right:center[0]+halfWidth+4,top:center[1]-size/2-4,bottom:center[1]+size/2+4};
    if(placed.every(b=>box.right<b.left||box.left>b.right||box.bottom<b.top||box.top>b.bottom))break;
   }
   placed.push(box);
   const label=el('text',{x:center[0],y:center[1],dy:'.35em','text-anchor':'middle','font-size':size,'font-weight':active.includes(i)?600:400,fill:c,stroke:'var(--page)','stroke-width':4,'stroke-linejoin':'round','paint-order':'stroke',style:'font-variant-numeric:tabular-nums','data-axis-value':i},labels);label.textContent=text;
  }
 }
 local(e){const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(this.svg.getScreenCTM().inverse());return [p.x,p.y];}
 down(e){if(!e.target.closest('.space-point')||e.button!==0||this.transition)return;e.preventDefault();this.drag={last:this.local(e),q:this.model.q.slice(),raw:this.model.q.slice(),pointer:e.pointerId,axis:null,snap:{axis:null,direction:null},intent:[0,0],mode:null};this.host.classList.add('dragging');this.host.setPointerCapture(e.pointerId);}
 move(e){
  if(!this.drag)return;e.preventDefault();const coalesced=e.getCoalescedEvents?.(),samples=coalesced?.length?coalesced:[e],mode=this.rule==='axis'||e.shiftKey?'axis':this.rule;
  // The flat three-axis projection crowds the diagonal. A ten-degree score
  // allowance expands each of its direction windows from 45 to 55 degrees.
  const diagonalBias=this.dimension===3&&!this.tilted?10*Math.PI/180:0;
  let active=null;
  if(mode!==this.drag.mode){
   const previous=this.drag.mode==='axis'?this.drag.axis:this.drag.snap.axis;
   this.drag.axis=mode==='axis'?previous:null;this.drag.snap={axis:previous,direction:previous===null?null:axisOrientation(this.basis[previous])};this.drag.intent=[0,0];this.drag.mode=mode;
  }
  // Keep the full path, but wait for a few pixels before committing to its
  // initial direction. Only axis selection is smoothed, not the displacement.
  for(const sample of samples){
   const p=this.local(sample);let delta=[p[0]-this.drag.last[0],p[1]-this.drag.last[1]];this.drag.last=p;if(Math.hypot(...delta)<1e-7)continue;
   if(mode!=='blend'&&(mode==='axis'?this.drag.axis:this.drag.snap.axis)===null){
    this.drag.intent=this.drag.intent.map((x,i)=>x+delta[i]);if(Math.hypot(...this.drag.intent)<4)continue;
    delta=this.drag.intent;this.drag.intent=[0,0];if(mode==='axis')this.drag.axis=dominantAxis(delta,this.basis,diagonalBias);
   }
   const axis=mode==='axis'?this.drag.axis:mode==='snap'?stableSnapAxis(delta,this.basis,this.drag.snap,diagonalBias):null;
   const dq=directionalDelta(delta,this.basis,axis);dq.forEach((x,i)=>{this.drag.raw[i]+=x;});
   // A coalesced event may contain a turn. Highlight the current direction,
   // rather than every axis touched earlier in that packet.
   active=axis===null?dq.flatMap((x,i)=>Math.abs(x)>1e-10?[i]:[]):[axis];
  }
  if(active===null)return;
  this.drag.limited=this.drag.raw.flatMap((q,i)=>q< -1e-8||q>1+1e-8?[i]:[]);this.model.setQ(this.drag.raw,active);
 }
 up(){if(!this.drag)return;const id=this.drag.pointer;this.drag=null;this.host.classList.remove('dragging');if(this.host.hasPointerCapture(id))this.host.releasePointerCapture(id);this.model.emit();}
 cancel(){if(!this.drag)return;const q=this.drag.q;this.up();this.model.setQ(q);}
 key(e){if(e.key==='Escape'){this.cancel();return;}if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||!e.target.closest('.space-point'))return;e.preventDefault();const i=e.shiftKey&&this.dimension>=3?2:['ArrowLeft','ArrowRight'].includes(e.key)?0:Math.min(1,this.dimension-1);this.model.setParameter(i,this.model.q[i]+(['ArrowRight','ArrowUp'].includes(e.key)?.02:-.02));}
}
window.PlankWidgets={PlankModel,PlankDiagram,ParameterSpace,directionalDelta,projectedBasis,gapColor,theme};
})();

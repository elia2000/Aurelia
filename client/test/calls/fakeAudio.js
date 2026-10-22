// A stand-in for the Web Audio API that records what was scheduled, and can
// behave like a browser that has not let the page make sound yet.

class FakeParam {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  record(type, value, time, extra) {
    this.events.push({ type, value, time, ...extra });
  }
  setValueAtTime(value, time) {
    this.record("set", value, time);
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this.record("linear", value, time);
    return this;
  }
  exponentialRampToValueAtTime(value, time) {
    this.record("exponential", value, time);
    return this;
  }
  setTargetAtTime(value, time, constant) {
    this.record("target", value, time, { constant });
    return this;
  }
  cancelScheduledValues(time) {
    this.record("cancel", undefined, time);
    return this;
  }
}

class FakeNode {
  constructor() {
    this.connections = [];
    this.disconnected = false;
  }
  connect(destination) {
    this.connections.push(destination);
    return destination;
  }
  disconnect() {
    this.disconnected = true;
  }
}

export class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.frequency = new FakeParam(440);
    this.type = "sine";
    this.wave = null;
    this.startedAt = null;
    this.stopCalls = [];
  }
  setPeriodicWave(wave) {
    this.wave = wave;
  }
  start(time) {
    this.startedAt = time;
  }
  stop(time) {
    this.stopCalls.push(time);
  }
  /** Whether the oscillator has been told to stop right now (no argument), as a ring being cut short does. */
  get stoppedNow() {
    return this.stopCalls.some((time) => time === undefined);
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeParam(1);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.allowed]  whether the browser lets the page start sound (a tap has happened)
 * @param {boolean} [options.sinkId]   whether AudioContext.setSinkId exists
 * @param {boolean} [options.startSuspended]  a new context is suspended even when allowed, until resume() (Safari)
 */
export function makeFakeAudio({ allowed = true, sinkId = false, startSuspended = false } = {}) {
  const env = {
    allowed,
    startSuspended,
    contexts: [],
    resumeCalls: 0,
    sinkCalls: [],
    badSinks: new Set(),
    /** Lets the page start sound from now on; contexts waiting to be resumed are not resumed by this alone. */
    allow() {
      env.allowed = true;
    },
    get context() {
      return env.contexts[env.contexts.length - 1] || null;
    },
    oscillators() {
      return env.contexts.flatMap((context) => context.oscillators);
    },
    frequencies() {
      return env.oscillators().map((oscillator) => oscillator.frequency.value);
    },
    /** The gain of the master volume node of the newest context. */
    masterGain() {
      return env.context?.master?.gain.value;
    },
  };

  class FakeAudioContext extends EventTarget {
    constructor() {
      super();
      this.state = env.allowed && !env.startSuspended ? "running" : "suspended";
      this.currentTime = 10;
      this.destination = new FakeNode();
      this.oscillators = [];
      this.gains = [];
      this.waves = [];
      this.closed = false;
      this.master = null;
      if (sinkId) {
        this.setSinkId = async (id) => {
          env.sinkCalls.push(id);
          if (env.badSinks.has(id)) throw new Error("NotFoundError");
        };
      }
      env.contexts.push(this);
    }
    setState(state) {
      this.state = state;
      this.dispatchEvent(new Event("statechange"));
    }
    createGain() {
      const gain = new FakeGain();
      this.gains.push(gain);
      if (!this.master) this.master = gain; // the first one is the master volume
      return gain;
    }
    createOscillator() {
      const oscillator = new FakeOscillator();
      this.oscillators.push(oscillator);
      return oscillator;
    }
    createPeriodicWave(real, imag) {
      const wave = { real, imag };
      this.waves.push(wave);
      return wave;
    }
    createBuffer() {
      return { silent: true };
    }
    createBufferSource() {
      return Object.assign(new FakeNode(), { start() {}, buffer: null });
    }
    resume() {
      env.resumeCalls += 1;
      if (this.closed) return Promise.reject(new Error("closed"));
      if (!env.allowed) return new Promise(() => {}); // like a browser that is still waiting for a tap
      if (this.state !== "running") this.setState("running");
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      this.state = "closed";
      return Promise.resolve();
    }
  }

  env.Context = FakeAudioContext;
  return env;
}

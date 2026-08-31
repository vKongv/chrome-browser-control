(function (global) {
  const ALLOWED_METHODS = Object.freeze(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent']);
  const DEFAULT_ATTACH_TTL_MS = 600_000;
  const MAX_ATTACH_TTL_MS = 3_600_000;
  const MIN_ATTACH_TTL_MS = 1_000;

  const SPECIAL_KEYS = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
  };

  function assertCdpMethod(method) {
    if (!ALLOWED_METHODS.includes(method)) {
      throw new Error(`CDP_METHOD_NOT_PERMITTED: ${method} is not in the CDP method allowlist`);
    }
  }

  function boundedAttachTtl(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ATTACH_TTL_MS;
    return Math.max(MIN_ATTACH_TTL_MS, Math.min(Math.floor(value), MAX_ATTACH_TTL_MS));
  }

  function clickCommands(x, y) {
    const point = {
      x: Math.round(Number(x)),
      y: Math.round(Number(y)),
      button: 'left',
      clickCount: 1
    };
    return [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', ...point } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...point } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...point } }
    ];
  }

  function parseKeySpec(spec) {
    const parts = String(spec).split('+').filter(Boolean);
    const key = parts.pop() || spec;
    const modifiers = new Set(parts.map((part) => part.toLowerCase()));
    return {
      key,
      ctrlKey: modifiers.has('ctrl') || modifiers.has('control'),
      metaKey: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
      altKey: modifiers.has('alt') || modifiers.has('option'),
      shiftKey: modifiers.has('shift')
    };
  }

  function modifierBits({ altKey, ctrlKey, metaKey, shiftKey }) {
    return (altKey ? 1 : 0) + (ctrlKey ? 2 : 0) + (metaKey ? 4 : 0) + (shiftKey ? 8 : 0);
  }

  function descriptorForKey(key) {
    if (SPECIAL_KEYS[key]) return { ...SPECIAL_KEYS[key] };
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (/[A-Z]/.test(upper) && /[a-zA-Z]/.test(key)) {
        return {
          key,
          code: `Key${upper}`,
          windowsVirtualKeyCode: upper.charCodeAt(0),
          text: key
        };
      }
      if (/[0-9]/.test(key)) {
        return {
          key,
          code: `Digit${key}`,
          windowsVirtualKeyCode: key.charCodeAt(0),
          text: key
        };
      }
      return {
        key,
        code: '',
        windowsVirtualKeyCode: key.charCodeAt(0),
        text: key
      };
    }
    return {
      key,
      code: key,
      windowsVirtualKeyCode: 0
    };
  }

  function keyEventCommands(spec) {
    const parsed = parseKeySpec(spec);
    const descriptor = descriptorForKey(parsed.key);
    const modifiers = modifierBits(parsed);
    const base = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers
    };
    const commands = [{ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...base } }];
    if (descriptor.text && !parsed.ctrlKey && !parsed.metaKey && !parsed.altKey) {
      commands.push({
        method: 'Input.dispatchKeyEvent',
        params: { type: 'char', ...base, text: descriptor.text, unmodifiedText: descriptor.text }
      });
    }
    commands.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } });
    return commands;
  }

  function typeTextCommands(text) {
    const commands = [];
    for (const character of String(text)) {
      commands.push(...keyEventCommands(character));
    }
    return commands;
  }

  function keypressCommands(keys) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const commands = [];
    for (const spec of keyList) {
      if (!spec) throw new Error('keypress requires keys');
      commands.push(...keyEventCommands(spec));
    }
    return commands;
  }

  global.BrowserControlCdp = {
    ALLOWED_METHODS,
    DEFAULT_ATTACH_TTL_MS,
    assertCdpMethod,
    boundedAttachTtl,
    clickCommands,
    typeTextCommands,
    keypressCommands
  };
})(globalThis);

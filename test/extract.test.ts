import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCacheDir } from '../src/extract.js';

describe('defaultCacheDir', () => {
  it('sits under ~/.config/nutrient', () => {
    expect(defaultCacheDir({}, '/home/ada')).toBe(
      join('/home/ada', '.config', 'nutrient', 'docsignals', 'cache'),
    );
  });

  it('follows XDG_CONFIG_HOME', () => {
    expect(defaultCacheDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/ada')).toBe(
      join('/xdg', 'nutrient', 'docsignals', 'cache'),
    );
  });
});

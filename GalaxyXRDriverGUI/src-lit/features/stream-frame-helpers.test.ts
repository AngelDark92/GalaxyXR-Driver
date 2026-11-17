import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bandwidthRowState } from './stream-frame-helpers';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tapOn = { forceCbr: false, tapActive: true, tapUnsupported: false };

describe('bandwidth row CBR state', () => {
  it('uses Average Bitrate label and adds a pin notice under Force CBR with the tap on', () => {
    const state = bandwidthRowState({ ...tapOn, forceCbr: true });
    expect(state.label).toBe('Average Bitrate (Mbit/s)');
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].title).toBe('Force CBR is on');
    expect(state.notices[0].body).toBe('The bitrate curve, constancy and headroom are saved but not applied. The encoder average and maximum both equal this budget.');
  });

  it('uses Max Bitrate label and no notices when Force CBR is off with the tap on', () => {
    const state = bandwidthRowState(tapOn);
    expect(state.label).toBe('Max Bitrate (Mbit/s)');
    expect(state.notices).toHaveLength(0);
  });
});

describe('bandwidth row NVENC Tap state', () => {
  it('stays Max Bitrate and explains the pacing-only budget with the tap off, even under Force CBR', () => {
    const state = bandwidthRowState({ forceCbr: true, tapActive: false, tapUnsupported: false });
    // CBR cannot apply without the tap, so neither its label nor its notice shows.
    expect(state.label).toBe('Max Bitrate (Mbit/s)');
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].intent).toBe('info');
    expect(state.notices[0].compact).toBe(true);
    expect(state.notices[0].title).toBe('NVENC Tap is off: pacing budget only');
    expect(state.notices[0].body).toContain('targetBandwidth');
    expect(state.notices[0].body).toContain('recommendedBandwidthMbit');
    expect(state.notices[0].body).toContain('scaling above 350 Mbit/s');
    expect(state.notices[0].body).toContain('bitrate curve');
    expect(state.notices[0].body).toContain('constancy');
    expect(state.notices[0].body).toContain('headroom');
    expect(state.notices[0].body).toContain('Force CBR');
  });

  it('names the unsupported verdict instead of an off switch', () => {
    const state = bandwidthRowState({ forceCbr: false, tapActive: true, tapUnsupported: true });
    expect(state.label).toBe('Max Bitrate (Mbit/s)');
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].title).toBe('NVENC Tap is unsupported: pacing budget only');
  });

  it('reports the tap as off before unsupported when both apply', () => {
    const state = bandwidthRowState({ forceCbr: true, tapActive: false, tapUnsupported: true });
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].title).toBe('NVENC Tap is off: pacing budget only');
  });
});

describe('stream-frame-page CBR wiring (source regression)', () => {
  const page = read('./stream-frame-page.ts');

  it('drives the bandwidth label through the extracted helper with tap state', () => {
    expect(page).toContain("import { bandwidthRowState } from './stream-frame-helpers';");
    expect(page).toContain('const bandwidth = bandwidthRowState({');
    expect(page).toContain('forceCbr: !!settings.nvencForceCbr && !!settings.nvencTap,');
    expect(page).toContain('tapActive: !!settings.nvencTap,');
    expect(page).toContain("tapUnsupported: tapVerdict.verdict === 'unsupported',");
    expect(page).toContain('fieldRow(bandwidth.label,');
    expect(page).toContain('notices: bandwidth.notices,');
  });

  it('keeps saved-but-not-applied notices for the curve and constancy rows under CBR', () => {
    expect(page).toContain("title: t('Saved but not applied while Force CBR is on')");
    expect(page).toContain("body: t('The curve selection is kept; it will apply again if you turn Force CBR off.')");
    expect(page).toContain("body: t('The constancy percentage is kept; it will apply again if you turn Force CBR off.')");
  });

  it('extracts both label strings individually for localization', () => {
    const helper = read('./stream-frame-helpers.ts');
    expect(helper).toContain("t('Average Bitrate (Mbit/s)')");
    expect(helper).toContain("t('Max Bitrate (Mbit/s)')");
    expect(page).not.toMatch(/t\(\s*settings\.nvencForceCbr\s*\?\s*['"]/);
  });

  it('orders Stream Quality as Tile Width, NVENC Tap, codec, Max Bitrate, restore', () => {
    const at = (needle: string) => {
      const index = page.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    const tile = at("parts.push(fieldRow(t('Tile Width'), html`");
    const tap = at("parts.push(settingFieldRow('streamFrame.nvencTap', html`");
    const codec = at("parts.push(settingFieldRow('streamFrame.nvencCodec', html`");
    const maxBitrate = at('fieldRow(bandwidth.label,');
    const restore = at("parts.push(fieldRow(t('Restore Steam Link encoder behaviour'), html`");
    expect(tile).toBeLessThan(tap);
    expect(tap).toBeLessThan(codec);
    expect(codec).toBeLessThan(maxBitrate);
    expect(maxBitrate).toBeLessThan(restore);
    // The invalid-setting error stays with the Max Bitrate row.
    const invalid = at("t('Invalid stream setting')");
    expect(maxBitrate).toBeLessThan(invalid);
    expect(invalid).toBeLessThan(restore);
  });

  it('no longer renders the retired bandwidth override row', () => {
    expect(page.includes('nvencBandwidthOverrideMbit')).toBe(true); // only the migration note names it
    expect(page).not.toContain("t('Bandwidth Override (Mbit/s)')");
    expect(page).not.toMatch(/settings\.nvencBandwidthOverrideMbit/);
  });
});

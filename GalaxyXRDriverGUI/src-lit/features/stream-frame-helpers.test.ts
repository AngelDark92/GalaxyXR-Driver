import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bandwidthRowState } from './stream-frame-helpers';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('bandwidth row CBR state', () => {
  it('uses Average Bitrate label and adds a pin notice under Force CBR', () => {
    const state = bandwidthRowState(true);
    expect(state.label).toBe('Average Bitrate (Mbit/s)');
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].title).toBe('Force CBR is on');
    expect(state.notices[0].body).toBe('The bitrate curve, constancy and headroom are saved but not applied. The encoder average and maximum both equal this budget.');
  });

  it('uses Max Bitrate label and no notices when Force CBR is off', () => {
    const state = bandwidthRowState(false);
    expect(state.label).toBe('Max Bitrate (Mbit/s)');
    expect(state.notices).toHaveLength(0);
  });
});

describe('stream-frame-page CBR wiring (source regression)', () => {
  const page = read('./stream-frame-page.ts');

  it('drives the bandwidth label through the extracted helper', () => {
    expect(page).toContain("import { bandwidthRowState } from './stream-frame-helpers';");
    expect(page).toContain('const bandwidth = bandwidthRowState(!!settings.nvencForceCbr);');
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
});

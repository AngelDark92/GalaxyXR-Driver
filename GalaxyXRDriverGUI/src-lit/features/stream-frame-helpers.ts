import { t } from '../locale/i18n';
import type { FieldNotice } from '../ui/presentation';

export interface BandwidthRowInput {
  /** streamFrame.nvencForceCbr as stored. */
  forceCbr: boolean;
  /** The NVENC Tap is requested; without it no encoder override applies. */
  tapActive: boolean;
  /** nvencTapSupport verdict for the effective adapter. */
  tapUnsupported: boolean;
}

/** Label and row-owned notices for the bandwidth row. Force CBR changes the
 *  label and adds a notice that the saved curve, constancy and headroom are
 *  preserved but not applied. With the NVENC Tap off or unsupported, only the
 *  Steam Link pacing budget applies, so the row says so — and the CBR label
 *  and notice wait until CBR can actually take effect. */
export function bandwidthRowState({ forceCbr, tapActive, tapUnsupported }: BandwidthRowInput): { label: string; notices: FieldNotice[] } {
  const cbrApplied = forceCbr && tapActive && !tapUnsupported;
  const label = cbrApplied ? t('Average Bitrate (Mbit/s)') : t('Max Bitrate (Mbit/s)');
  const notices: FieldNotice[] = cbrApplied
    ? [{
        intent: 'info',
        title: t('Force CBR is on'),
        body: t('The bitrate curve, constancy and headroom are saved but not applied. The encoder average and maximum both equal this budget.'),
        compact: true,
      }]
    : [];
  if (!tapActive) {
    notices.push({
      intent: 'info',
      title: t('NVENC Tap is off: pacing budget only'),
      body: t('Only the Steam Link pacing budget applies: targetBandwidth and recommendedBandwidthMbit take this value. The scaling above 350 Mbit/s, the bitrate curve, constancy, headroom and Force CBR need the NVENC Tap.'),
      compact: true,
    });
  } else if (tapUnsupported) {
    notices.push({
      intent: 'info',
      title: t('NVENC Tap is unsupported: pacing budget only'),
      body: t('Only the Steam Link pacing budget applies: targetBandwidth and recommendedBandwidthMbit take this value. The scaling above 350 Mbit/s, the bitrate curve, constancy, headroom and Force CBR need the NVENC Tap.'),
      compact: true,
    });
  }
  return { label, notices };
}

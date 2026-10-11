import hotstarIcon from '../assets/app-icons/hotstar.png';
import netflixIcon from '../assets/app-icons/netflix.png';
import primeIcon from '../assets/app-icons/prime.jpg';
import smarttubeIcon from '../assets/app-icons/smarttube.png';
import sonylivIcon from '../assets/app-icons/sonyliv.png';
import stremioIcon from '../assets/app-icons/stremio.png';

export type AppShortcut = {
  id: string;
  label: string;
  /** Preferred deep link / package launch URI for Android TV Remote. */
  appLink: string;
  /** Extra links tried after the primary. */
  fallbackLinks?: string[];
  /**
   * When true, every candidate link is sent (short delay between them).
   * Needed because Android TV often ACKs app-link messages even when the
   * package/deep link did not open anything.
   */
  tryAllLinks?: boolean;
  icon: string;
  accent: string;
};

function leanbackLaunch(packageName: string): string {
  return `#Intent;action=android.intent.action.MAIN;category=android.intent.category.LEANBACK_LAUNCHER;package=${packageName};end`;
}

function leanbackLaunchIntent(packageName: string): string {
  return `intent:${leanbackLaunch(packageName)}`;
}

/**
 * Fixed display order — launching an app must not reshuffle this list.
 */
export const APP_SHORTCUTS: AppShortcut[] = [
  {
    id: 'netflix',
    label: 'Netflix',
    appLink: 'https://www.netflix.com/title',
    fallbackLinks: ['market://launch?id=com.netflix.ninja', 'netflix://'],
    icon: netflixIcon,
    accent: '#e50914',
  },
  {
    id: 'hotstar',
    label: 'Hotstar',
    appLink: 'hotstar://',
    fallbackLinks: [
      'https://www.hotstar.com',
      leanbackLaunch('in.startv.hotstar'),
      leanbackLaunch('in.startv.hotstar.dplus'),
      leanbackLaunch('in.startv.hotstartvonly'),
      'market://launch?id=in.startv.hotstar',
    ],
    tryAllLinks: true,
    icon: hotstarIcon,
    accent: '#1b1361',
  },
  {
    id: 'sonyliv',
    label: 'Sony Liv',
    appLink: 'https://www.sonyliv.com',
    fallbackLinks: [leanbackLaunch('com.sonyliv'), 'market://launch?id=com.sonyliv', 'sonyliv://'],
    tryAllLinks: true,
    icon: sonylivIcon,
    accent: '#111111',
  },
  {
    id: 'prime',
    label: 'Prime',
    appLink: 'https://app.primevideo.com',
    fallbackLinks: [
      leanbackLaunch('com.amazon.amazonvideo.livingroom'),
      'market://launch?id=com.amazon.amazonvideo.livingroom',
    ],
    icon: primeIcon,
    accent: '#00a8e1',
  },
  {
    id: 'smarttube',
    label: 'Youtube',
    // market://launch is broken on many Google TV builds — prefer Intent + bare package.
    appLink: leanbackLaunch('org.smarttube.stable'),
    fallbackLinks: [
      leanbackLaunchIntent('org.smarttube.stable'),
      'org.smarttube.stable',
      'market://launch?id=org.smarttube.stable',
      'vnd.youtube.launch://www.youtube.com',
      'vnd.youtube://www.youtube.com',
    ],
    tryAllLinks: true,
    icon: smarttubeIcon,
    accent: '#ff0000',
  },
  {
    id: 'stremio',
    label: 'Stremio',
    appLink: 'stremio:///',
    fallbackLinks: [
      leanbackLaunch('com.stremio.one'),
      leanbackLaunch('com.stremio.androidtv'),
      'market://launch?id=com.stremio.one',
    ],
    icon: stremioIcon,
    accent: '#7b2ff7',
  },
];

export function launchLinksFor(app: AppShortcut): string[] {
  return [app.appLink, ...(app.fallbackLinks ?? [])].filter(
    (link, index, all) => Boolean(link) && all.indexOf(link) === index
  );
}

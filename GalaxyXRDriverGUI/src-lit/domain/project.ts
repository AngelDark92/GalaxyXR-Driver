// This fork's updates and project links must use the same repository.
export const projectRepository = 'AngelDark92/GalaxyXR-Driver';
export const projectUrl = `https://github.com/${projectRepository}`;
export const latestReleaseApiUrl = `https://api.github.com/repos/${projectRepository}/releases/latest`;
// Dev Updates channel: the releases list includes pre-releases, which
// /releases/latest excludes; 100 (the endpoint's page-size max) keeps the
// newest stable release in the candidate window even when many pre-releases
// stack above it.
export const releasesApiUrl = `https://api.github.com/repos/${projectRepository}/releases?per_page=100`;

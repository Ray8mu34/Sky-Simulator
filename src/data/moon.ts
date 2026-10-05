import colorUrl from '../../assets/runtime/moon-color-1k.webp?inline';

/** Fixed NASA CGI Moon Kit2019 display texture; no network request at runtime. */
export const moonColorUrl: string = colorUrl;
export const moonTextureMetadata = {
  source: 'https://svs.gsfc.nasa.gov/4720/',
  revision: '2019 CGI Moon Kit',
  dimensions: [1024, 512] as const,
  projection: 'equirectangular',
  colorSpace: 'sRGB',
  /** Image/Three texture u=0,.25,.5,.75,1 => lunar180W,90W,0,90E,180E. */
  longitudeEastDegAtU: [-180, -90, 0, 90, 180] as const,
  northAtImageTop: true,
  eastIncreasesRightward: true,
  sourceNote: 'NASA SVS / Ernie Wright; LROC WAC and LOLA. NASA2019 aesthetic color map; not quantitative photometry.',
} as const;

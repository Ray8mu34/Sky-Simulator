# NASA Deep Star Maps2020: celestial Milky Way background

Source: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps2020, SVS4851, released2020-09-09. https://svs.gsfc.nasa.gov/4851/
Selected original: milkyway_2020_4k.exr, celestial background-only layer. It omits the bright Hipparcos/Tycho foreground. The full starmap and hiptyc foreground images are separate files retained only as QA previews, not included in runtime. The galactic-coordinate maps are not selected.
Original source SHA256: 2eb802d6e68d170b410f766c7fec07f7518619f6b6708fdc81e9302d93e74fdb (36,436,668 bytes,4096×2048).

Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio; Ernie Wright (USRA), animator; GaiaDR2: ESA/Gaia/DPAC. Supporting faint-star catalog data include UCAC3. The NASA constellation figure overlays credited to the IAU/Alan MacRobert are not used in this background asset.

NASA Images and Media Usage Guidelines apply: https://www.nasa.gov/nasa-brand-center/images-and-media/ . NASA content is generally not subject to copyright in the United States and may be used for educational/informational material with acknowledgment, subject to the guidelines. Do not imply NASA endorsement. No NASA logo, person or separately marked third-party illustration is included. ESA/Gaia data credits are preserved separately below; this does not label all third-party observational data as US government work or claim CC0.

Gaia official data credit/citation and usage source (hash-locked):
https://gea.esac.esa.int/archive/documentation/GDR2/Miscellaneous/sec_credit_and_citation_instructions/

The Gaia data are open and free to use, provided credit is given to ESA/Gaia/DPAC. The required research acknowledgment is reproduced here to retain the underlying data provenance:
"This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement."
Data references: Gaia Collaboration, Prusti et al.(2016), The Gaia mission, Astronomy & Astrophysics595,A1, doi:10.1051/0004-6361/201629272; Gaia Collaboration, Brown et al.(2018), Gaia Data Release2: Summary of the contents and survey properties, Astronomy & Astrophysics616,A1, doi:10.1051/0004-6361/201833051.

Processing: existing OpenCV4.12 EXR decoder, fixed linear exposure1, componentwise Reinhard x/(1+x), standard linear-to-sRGB transfer, round8bit, then Lanczos downsample of the same LDR master to2K/1K and WebPquality88/85. No per-image/per-resolution normalization, added stars, nebulosity painting, longitude shift or flip. Runtime never loads the large EXR. All outputs are written fully to temporary files then atomically replaced.

Coordinates: source ICRF/J2000 geocentric RA/Dec plate-carrée, approximate EQJ. RA0 at image center, RA increases left, north at top. u=fract(.5-RAhours/24); image row v=.5-Dec/180. Texture.flipY=true sampler v=.5+Dec/180. RA12 is the horizontal wrap seam. The map must use the same direction/frame transform as the star catalog; it is not attached to the screen or Earth's geographic rotation.

Direction-anchor metadata: the three HIP star-region numeric coordinates are derived from HYG4.1 (CC-BY-SA4.0), with confirmed Chinese labels from Stellariumv24.4 (CC-BY-SA4.0). Those metadata components retain that attribution/share-alike license separately from the NASA image pixels. The complete HYG/STELLARIUM notices and CC-BY-SA4.0 text accompany this notice. Galactic-centre numeric reference is cited to NASA/CXC Chandra2010, and the independent SIMBAD records remain QA references.

Limits: static catalog-derived density visualization, not calibrated sky radiance, current airglow, weather, dust-emission photometry, or a recovered complete Milky Way luminosity map. NASA uses HIP stars brighter thanV8, TychoV8..11.5 and Gaia faint stars. Since runtime selectable stars mostly stop atV6.5, the integrated6.5..11.5 foreground contribution is largely absent. Catalog blends/variables and V/G passband differences also prevent promising absolutely zero residual overlap. No second full star map or invented stars were added to fill this gap. Light-pollution response and renderer intensity/saturation are qualitative display controls, not measured Bortle/SQM/flux calibration.

# NASA CGI Moon Kit2019

Source: NASA Scientific Visualization Studio CGI Moon Kit, SVS4720, originally released2019-09-06. https://svs.gsfc.nasa.gov/4720/
Selected file: the2019 lroc_color_poles_1k.jpg (1024×512), not the separate2025 update. Original source SHA256: b246064f217f8d479df78c49c7c8595a8f5fbda008a72fd539978d2e121e0109. The2019 official1K image is transcoded to RGB WebPquality88 without flipping, rotation, longitude offset or additional downsampling. A2K TIFF transfer timed out; its incomplete development download is excluded and has never been used to generate runtime data.

Credit: NASA's Scientific Visualization Studio; Ernie Wright (USRA), visualizer; Noah Petro (NASA/GSFC), scientist. Underlying natural-color Hapke normalized WAC mosaic: Lunar Reconnaissance Orbiter Camera team, Arizona State University; polar albedo fill: Lunar Orbiter Laser Altimeter team.
LROC source technical reference: Sato et al.(2017), Lunar Mare TiO2 Abundances Estimated from UV/Vis Reflectance, Icarus296,216–238, DOI10.1016/j.icarus.2017.06.013.

NASA uses643/566/415nm bands asRGB, adjusts exposure/white balance, fills some missing high-latitude data and extends beyond±70° with lower-resolution LOLA monochrome albedo. The map is optimized for aesthetics; the runtime texture is a display color map, not scientific photometry or a current observation.

The lunar equirectangular map is centered on0° longitude, north at top, east-positive longitude increases rightward. u=0,.25,.5,.75,1 correspond to180W,90W,0,90E,180E. Orientation was checked against IAU/USGS Mare Crisium59.10E16.18N and Tycho11.36W43.31S, identifiable in the source image; no arbitrary rotation was used to make it look pleasing.
Feature coordinate references: https://planetarynames.wr.usgs.gov/Feature/3671 and https://planetarynames.wr.usgs.gov/Feature/6163 (independent QA snapshots, not additional runtime maps).

Use follows NASA Images and Media Usage Guidelines, https://www.nasa.gov/nasa-brand-center/images-and-media/ . NASA content is generally not subject to copyright in the United States and may be used for educational/informational material with source acknowledgment subject to the guidelines. Do not imply NASA endorsement. No NASA logo, people or separately marked third-party image is included. NASA media conditions remain separate from the application code and the CC BY-SA star-data licenses.

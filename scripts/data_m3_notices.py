"""Preserve generator MIT license and exact HKO QA reuse notices as distributable text."""
from html.parser import HTMLParser
import re
from data_build import ROOT, SOURCE, atomic_write

class PlainNotice(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag in {'br','p','li','h1','ol'}: self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in {'p','li','h1','ol'}: self.parts.append('\n')
    def handle_data(self,data): self.parts.append(data)

def notice(path):
    html=path.read_text(encoding='utf-8')
    section=html.split('<!--Begin Content-->',1)[1].split('<!--End Content-->',1)[0]
    section=re.sub(r'<script\b[^>]*>.*?</script>','',section,flags=re.S)
    parser=PlainNotice(); parser.feed(section)
    return '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())

def main():
    licenses=ROOT/'assets/licenses'
    atomic_write(licenses/'LUNAR-TYPESCRIPT-MIT.txt',(SOURCE/'lunar-typescript/LICENSE').read_bytes())
    hko='''# Hong Kong Observatory independent QA materials

The Hong Kong Special Administrative Region Government is the intellectual property rights owner of the HKO materials. Source: Hong Kong Observatory publications / website, https://www.hko.gov.hk/ . Downloaded yearly TXT/PDF and extracted checked rows are retained only as independent, noncommercial educational QA records in this repository. They are excluded from the runtime Web/portable application and are not licensed MIT or CC0. Runtime lunar month starts are generated independently by fixed MIT lunar-typescript1.8.6; this does not claim HKO endorsement. HKO states future new moons near midnight may change a civil date by one day, including2057-09-28,2089-09-04,2097-08-07.

The full notices / conditions below are reproduced from the hash-locked official pages, with HTML navigation and scripts omitted. They govern HKO QA materials only. Their presence does not relicense application code or independently generated data. Commercial reuse of HKO materials requires following HKO's separate terms and obtaining applicable authorisation.

'''
    for filename,url in [('iprightsnotice.html','https://www.hko.gov.hk/en/publica/iprightsnotice.htm'),
                         ('non-commercialuse.html','https://www.hko.gov.hk/en/publica/non-commercialuse.htm'),
                         ('web-use-conditions.html','https://www.hko.gov.hk/tc/appweb/applink.htm')]:
        hko+=f'\nOfficial source: {url}\n\n'+notice(SOURCE/'hko'/filename)+'\n'
    atomic_write(licenses/'HKO-QA-NOTICE.md',hko.encode('utf-8'))
    lunar='''# Compact lunar civil calendar

Generator: lunar-typescript1.8.6 by6tail, MIT, exact Git commit a376ec2b8fd1b3069e24c92801bab8707fccd49d. https://github.com/6tail/lunar-typescript
The exact npm source package and upstream MIT license are hash-locked. The generator runs only at build time; no lunar-typescript code or dependency is imported by the browser. The compact table covers Gregorian1901-01-01 through2100-12-31 in UTC+08:00, including the first day's lunar1900 month and an exclusive terminal sentinel in2101.

HKO independent audit checked73,049 civil days. The fixed generator disagrees with the fixed HKO table on30 days,2057-09-28 through2057-10-27. The generator convention is retained, and every difference is recorded. All dates in2057,2089,2097 are marked uncertain because HKO explicitly warns the corresponding new moons may fall on an adjacent civil date. HKO raw and derived comparison rows remain QA sources only, outside the runtime releases. See HKO-QA-NOTICE.md for their separate conditions. No claim is made that a computed future civil lunar date is a measured new-moon instant, or that the HKO warnings affect the independent lunar phase/ephemeris model.

The included LUNAR-TYPESCRIPT-MIT.txt preserves the complete generator license notice.
'''
    atomic_write(licenses/'LUNAR-CALENDAR-NOTICE.md',lunar.encode('utf-8'))
    moon='''# NASA CGI Moon Kit2019

Source: NASA Scientific Visualization Studio CGI Moon Kit, SVS4720, originally released2019-09-06. https://svs.gsfc.nasa.gov/4720/
Selected file: the2019 lroc_color_poles_1k.jpg (1024×512), not the separate2025 update. Original source SHA256: b246064f217f8d479df78c49c7c8595a8f5fbda008a72fd539978d2e121e0109. The2019 official1K image is transcoded to RGB WebPquality88 without flipping, rotation, longitude offset or additional downsampling. A2K TIFF transfer timed out; its incomplete development download is excluded and has never been used to generate runtime data.

Credit: NASA's Scientific Visualization Studio; Ernie Wright (USRA), visualizer; Noah Petro (NASA/GSFC), scientist. Underlying natural-color Hapke normalized WAC mosaic: Lunar Reconnaissance Orbiter Camera team, Arizona State University; polar albedo fill: Lunar Orbiter Laser Altimeter team.
LROC source technical reference: Sato et al.(2017), Lunar Mare TiO2 Abundances Estimated from UV/Vis Reflectance, Icarus296,216–238, DOI10.1016/j.icarus.2017.06.013.

NASA uses643/566/415nm bands asRGB, adjusts exposure/white balance, fills some missing high-latitude data and extends beyond±70° with lower-resolution LOLA monochrome albedo. The map is optimized for aesthetics; the runtime texture is a display color map, not scientific photometry or a current observation.

The lunar equirectangular map is centered on0° longitude, north at top, east-positive longitude increases rightward. u=0,.25,.5,.75,1 correspond to180W,90W,0,90E,180E. Orientation was checked against IAU/USGS Mare Crisium59.10E16.18N and Tycho11.36W43.31S, identifiable in the source image; no arbitrary rotation was used to make it look pleasing.
Feature coordinate references: https://planetarynames.wr.usgs.gov/Feature/3671 and https://planetarynames.wr.usgs.gov/Feature/6163 (independent QA snapshots, not additional runtime maps).

Use follows NASA Images and Media Usage Guidelines, https://www.nasa.gov/nasa-brand-center/images-and-media/ . NASA content is generally not subject to copyright in the United States and may be used for educational/informational material with source acknowledgment subject to the guidelines. Do not imply NASA endorsement. No NASA logo, people or separately marked third-party image is included. NASA media conditions remain separate from the application code and the CC BY-SA star-data licenses.
'''
    atomic_write(licenses/'NASA-MOON-NOTICE.md',moon.encode('utf-8'))
    print('Preserved MIT license, NASA Moon credit, and complete HKO QA notices/conditions.')

if __name__=='__main__': main()

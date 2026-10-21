import m1 from '../../assets/runtime/m1.jpg?url';
import m31 from '../../assets/runtime/m31.jpg?url';
import m42 from '../../assets/runtime/m42.jpg?url';
export const deepSkyImages: Readonly<Record<number,{url:string; caption:string; credit:string}>> = {
  1:{url:m1,caption:'蟹状星云 · Hubble观测合成图',credit:'NASA/ESA/JPL/Arizona State Univ. · PIA03606'},
  31:{url:m31,caption:'仙女座星系 · GALEX紫外观测图',credit:'NASA/JPL/California Institute of Technology · PIA04921'},
  42:{url:m42,caption:'猎户座星云 · Hubble与Spitzer多波段合成图',credit:'NASA/JPL-Caltech/STScI · PIA01322'},
};

// Light or dark, for every page (the app, Help and the admin hub), set in the page's <head> so it never shows the
// wrong one first. A choice made in the menu (dp.theme.v1) is kept; otherwise it follows the daylight in Great
// Britain: light from sunrise to sunset, dark otherwise, and it changes at dusk and dawn while a page is open.
(function(g){
  'use strict';
  var KEY='dp.theme.v1',RAD=Math.PI/180,LAT=52.5,LON=-1.5; // the middle of Great Britain
  /** Sunrise and sunset on the (UTC) day of `d` (NOAA's short formula: within a few minutes). */
  function sun(d){
    var y=d.getUTCFullYear(),n=Math.round((Date.UTC(y,d.getUTCMonth(),d.getUTCDate())-Date.UTC(y,0,1))/864e5)+1;
    var decl=-23.44*Math.cos(RAD*360/365*(n+10));
    var b=RAD*360/365*(n-81),eot=9.87*Math.sin(2*b)-7.53*Math.cos(b)-1.5*Math.sin(b);
    var h=Math.acos((Math.sin(-0.833*RAD)-Math.sin(LAT*RAD)*Math.sin(decl*RAD))/(Math.cos(LAT*RAD)*Math.cos(decl*RAD)))/RAD;
    var noon=720-4*LON-eot,day=Date.UTC(y,d.getUTCMonth(),d.getUTCDate());
    return {rise:new Date(day+(noon-4*h)*6e4),set:new Date(day+(noon+4*h)*6e4)};
  }
  function isDaytime(d){var s=sun(d);return d>=s.rise&&d<s.set}
  function saved(){try{var v=g.localStorage.getItem(KEY);return v==='light'||v==='dark'?v:null}catch(e){return null}}
  function current(d){return saved()||(isDaytime(d||new Date())?'light':'dark')}
  function apply(){if(g.document)g.document.documentElement.dataset.theme=current()}
  g.dpTheme={KEY:KEY,sun:sun,isDaytime:isDaytime,saved:saved,current:current,apply:apply};
  apply();
  if(g.document)g.setInterval(function(){if(!saved())apply()},60000);
})(typeof window!=='undefined'?window:globalThis);

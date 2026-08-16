'use strict';

function n(v){ return v==null ? null : Number(v); }
function scorePortion(item, slot){
  const grams=n(item.portion_grams), unit=n(item.portion_unit_count), ml=n(item.portion_ml);
  if([grams,unit,ml].every(v=>v==null)) return {score:0.35,certainty:'UNKNOWN'};
  let penalty=0;
  if(grams!=null){
    const bands={
      'فطار':[40,600], 'سناك ١':[10,350], 'سناك ٢':[10,350], 'غداء':[80,800], 'عشاء':[60,700], 'سحور':[60,800]
    };
    const [min,max]=bands[slot] || [20,800];
    if(grams<min) penalty += Math.min(1,(min-grams)/min);
    if(grams>max) penalty += Math.min(1,(grams-max)/max);
  }
  if(unit!=null && unit<=0) penalty += 1;
  if(ml!=null && ml<=0) penalty += 1;
  return {score:Math.max(0,1-Math.min(1,penalty)),certainty:'KNOWN'};
}
module.exports={scorePortion};

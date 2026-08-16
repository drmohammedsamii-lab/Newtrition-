'use strict';
const Base=require('./optimizer');
const Rules=require('./planning-rules');
const Gate=require('./weekly-quality-gate');

async function generateWeekV5(pool,opts={}){
  const base=await Base.generateWeek(pool,opts);
  const baseQuality=base.quality;
  const quality=Gate.evaluate({
    days:base.days,
    targets:opts.targets||{},
    policy:opts.policy||{},
    baseQuality
  });
  return {
    ...base,
    quality,
    optimizer:'v5.0-weekly-multi-constraint-with-quality-gate',
    generated_at:new Date().toISOString(),
    recommendation: quality.ok
      ? (quality.status==='PASS'?'READY_FOR_CLINICAL_REVIEW':'REVIEW_WARNINGS')
      : 'REGENERATE_OR_MANUAL_REPAIR'
  };
}

function qualityFromPayload({days,targets,policy,baseQuality}){
  return Gate.evaluate({days,targets,policy,baseQuality});
}

module.exports={generateWeekV5,qualityFromPayload,qualityGate:Gate.evaluate,dayTypeSequence:Rules.dayTypeSequence};

'use strict';
const crypto=require('crypto');

function provider(){ return (process.env.PAYMENT_PROVIDER||'none').toLowerCase(); }
function requireProvider(expected){ const p=provider(); if(p!==expected) throw Object.assign(new Error('payment_provider_not_configured'),{status:503}); }
function verifyPaymobHmac(payload,received){
  const secret=process.env.PAYMOB_HMAC_SECRET||''; if(!secret||!received) return false;
  const canonical = [
    payload.amount_cents,payload.created_at,payload.currency,payload.id,payload.order_id,
    payload.success,payload.is_refund,payload.is_void,payload.is_capture,payload.pending,
    payload.integration_id,payload.source_data_pan,payload.source_data_sub_type,payload.source_data_type
  ].map(v=>String(v??'')).join('');
  const digest=crypto.createHmac('sha512',secret).update(canonical).digest('hex');
  try{return crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(String(received)));}catch{return false;}
}
function buildProviderConfig(){
  return {provider:provider(),configured:provider()!=='none' && !!(process.env.PAYMOB_API_KEY||process.env.STRIPE_SECRET_KEY)};
}
module.exports={provider,requireProvider,verifyPaymobHmac,buildProviderConfig};

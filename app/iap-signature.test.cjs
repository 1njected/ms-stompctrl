const assert=require('node:assert/strict'),crypto=require('node:crypto');require('./iap-signature.js');
(async()=>{const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:1024});const spki=publicKey.export({type:'spki',format:'der'}),message=crypto.randomBytes(32),digest=crypto.createHash('sha1').update(message).digest(),signature=crypto.sign('sha1',message,privateKey);assert(await IAPSignature.verify(spki,signature,digest));signature[0]^=1;assert.equal(await IAPSignature.verify(spki,signature,digest),false);assert.throws(()=>IAPSignature.spki(Uint8Array.from([48,130,1])));console.log('Valid RSA/SHA-1 digest signature, tamper rejection and malformed DER rejection passed');})().catch(e=>{console.error(e);process.exitCode=1;});

// The captured handshake is this pedal's certificate and one challenge it
// signed -- test data, not a secret, but not part of the app either. Where it
// is absent the synthetic RSA checks above still run and this one says it was
// skipped, rather than failing a checkout that does not carry the capture.
(async()=>{const fs=require('node:fs');const fixture=__dirname+'/browser-handshake-success-20260908.json';
 if(!fs.existsSync(fixture)){console.log('Captured pedal handshake absent; live certificate/signature check skipped');return;}
 const events=JSON.parse(fs.readFileSync(fixture));const value=k=>events.find(e=>e.kind===k).value;const bytes=h=>Buffer.from(h.replaceAll(' ',''),'hex');assert(await IAPSignature.verify(bytes(value('iap_auth_certificate').hex),bytes(value('iap_signature_rx').hex),bytes(value('iap_signature_challenge'))));console.log('Captured pedal certificate/challenge/signature verification passed');})().catch(e=>{console.error(e);process.exitCode=1;});

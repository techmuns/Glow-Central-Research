// An exact, exchange-confirmed subdivision must preserve issuer capture without changing the book.
import assert from 'node:assert/strict';
import {announcementIssuerIsin,createAnnouncementIdentity,mergeExchangeIdentities} from '../public/js/data/announcement-identity.js';
const old={isin:'INE24OJ01011',ticker:'BUILDPRO',bseCode:'544517',name:'Shankara Buildpro Ltd'},current={...old,isin:'INE24OJ01029'};
const statement={...old,units:10,mark:100};
const saved=structuredClone(statement);
const directory=mergeExchangeIdentities([old],[current]),identity=createAnnouncementIdentity(directory);
assert.equal(directory.length,1);
assert.equal(identity.find(statement).isin,current.isin);
assert.equal(identity.key(statement),identity.key({ticker:'BUILDPRO'}));
assert.equal(announcementIssuerIsin(old.isin),current.isin);
assert.equal(identity.find({...statement,isin:'INE000000099'}),null,'unknown explicit identities must never fall back to matching symbols/names');
assert.deepEqual(statement,saved,'announcement lookup must not mutate historical holdings');
console.log('PASS exact BUILDPRO issuer alias resolves the old statement and new directory, preserves holdings and rejects unverified identities');

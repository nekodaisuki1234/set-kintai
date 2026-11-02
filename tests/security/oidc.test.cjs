"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateIdentity} = require('../../scripts/aws-oidc-identity.cjs');
const identity = () => ({iss:'https://token.actions.githubusercontent.com',aud:'sts.amazonaws.com',
  repository:'nekodaisuki1234/set-kintai',repository_id:'1414011126',repository_owner_id:'79440835',
  ref:'refs/heads/main',sub:'repo:nekodaisuki1234/set-kintai:ref:refs/heads/main'});
test('accepts exact legacy and immutable main subjects, returns only nonsecret fields', () => {
  for (const sub of [identity().sub,'repo:nekodaisuki1234@79440835/set-kintai@1414011126:ref:refs/heads/main']) {
    const result = validateIdentity({...identity(),sub,extraSecret:'must not be returned'});
    assert.equal(result.subject,sub);assert.equal(Object.hasOwn(result,'extraSecret'),false);
  }
});
test('rejects forks, pull requests, other owners, environments and audiences', () => {
  for (const changes of [{repository:'attacker/set-kintai'},{repository_id:'10'},{repository_owner_id:'10'},
    {aud:'other'},{iss:'https://attacker.invalid'},{ref:'refs/pull/1/merge'},
    {sub:'repo:nekodaisuki1234/set-kintai:pull_request'},
    {sub:'repo:nekodaisuki1234/set-kintai:environment:development'},
    {sub:'repo:nekodaisuki1234@10/set-kintai@1414011126:ref:refs/heads/main'}]) {
    assert.throws(()=>validateIdentity({...identity(),...changes}));
  }
});

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { BOOKING_BUNDLE, ORDER_BUNDLE, createMigratedDb, createOwner, createOrder, createBooking, insert, uniq } from './helpers';
import * as runtime from '../src/runtime';
import { decideApproval } from '../src/guarded-updates';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); });
afterAll(async () => { await db.close(); });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const hash = (s: string) => 'sha256:' + digest(s);
async function app<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('set role abos_app');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const types = ['order_bundle','booking_bundle','fact_edit','price_edit'] as const;
type Bundle = typeof types[number];
async function proposal(type: Bundle = 'order_bundle', channel = 'surge', lifetime = 600_000) {
  const owner = await createOwner(db);
  const expiresAt = new Date(Date.now() + lifetime).toISOString();
  let subject: Record<string, unknown>;
  let fields: Record<string, unknown>;
  let actionBundle: string[];
  if (type === 'order_bundle') {
    subject = await createOrder(db, owner);
    actionBundle = ORDER_BUNDLE;
    fields = { agentVersionId: owner.agentVersionId, cartHash: subject.cart_hash, totalMinor: 1200, currency: 'USD', pickupAt: null,
      messageRecipient: '+15555550123', messageChannel: channel };
  } else if (type === 'booking_bundle') {
    subject = await createBooking(db, owner, { call_id: owner.callId });
    actionBundle = BOOKING_BUNDLE;
    fields = { agentVersionId: owner.agentVersionId, serviceId: subject.service_id, calendarId: subject.calendar_id,
      startUtc: (subject.start_utc as Date).toISOString(), endUtc: (subject.end_utc as Date).toISOString(), timezone: subject.timezone,
      messageRecipient: '+15555550123', messageChannel: channel };
  } else if (type === 'fact_edit') {
    subject = await insert(db, 'business_facts', { business_id: owner.businessId, kind: 'hours', key: 'mon',
      value: { slots: [1,2] }, source_type: 'owner_ui' });
    actionBundle = ['local.fact.update'];
    fields = { kind: 'hours', key: 'mon', fromVersion: 1, before: { slots: [1,2] }, after: { slots: [3,4] } };
  } else {
    subject = await insert(db, 'catalog_items', { business_id: owner.businessId, square_item_id: 'item', square_variation_id: 'variation',
      square_item_version: 1, square_variation_version: 1, item_name: 'Pizza', variation_name: 'Regular', price_minor: 1200, synced_at: new Date() });
    actionBundle = ['square.catalog.price.update','local.catalog.sync'];
    fields = { squareItemId: 'item', variationId: 'variation', fromPriceMinor: 1200, newPriceMinor: 1500, currency: 'USD', squareVersion: 1 };
  }
  const payload = { businessId: owner.businessId, subjectId: String(subject.id), ...fields, actionBundle, expiresAt };
  const args = { businessId: owner.businessId, bundleType: type, subjectId: String(subject.id), actorType: 'owner' as const,
    actorId: owner.userId, payload, canonical: JSON.stringify(payload), payloadHash: hash(JSON.stringify(payload)), actionBundle, expiresAt };
  return { owner, subject, args };
}
async function approved(type: Bundle = 'order_bundle', channel = 'surge') {
  const p = await proposal(type, channel);
  const a = await app(() => runtime.createApproval(db, p.args));
  const decision = { businessId: p.owner.businessId, approvalId: a.id, ownerUserId: p.owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' as const };
  const result = await app(() => runtime.runtimeDecideAndEnqueue(db, decision));
  return { ...p, a, decision, ...result };
}
const finish = (businessId: string, executionId: string, attempt = 1, workerId = 'worker', status: 'SUCCEEDED' | 'QUEUED' = 'SUCCEEDED') =>
  runtime.finishExecution(db, { businessId,executionId,workerId,attempt,status,externalRef: 'provider-' + executionId, retryAt: new Date(0) });

it('installs a nonowner, nonmember restricted runtime role', async () => {
  const { rows } = await db.query(`select rolcanlogin, rolinherit, rolcreatedb, rolcreaterole, rolbypassrls, rolsuper,
    (select count(*)::int from pg_auth_members where member=r.oid) as memberships from pg_roles r where rolname='abos_app'`);
  expect(rows).toEqual([{ rolcanlogin:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,rolsuper:false,memberships:0 }]);
});

for (const table of ['approval_requests','action_executions','message_dispatches','sync_jobs']) {
  for (const [operation,sql] of [
    ['INSERT',`insert into public.${table} default values`], ['UPDATE',`update public.${table} set id=id`],
    ['DELETE',`delete from public.${table}`], ['TRUNCATE',`truncate public.${table} cascade`],
  ]) it(`denies ordinary ${operation} on ${table} by permission`, async () => {
    await app(() => expect(db.query(sql!)).rejects.toMatchObject({ code: '42501' }));
  });
}

it('grants exactly the ordinary table operations and matching RLS policies', async () => {
  const writable = ['businesses','users','business_facts','files','catalog_items','fact_conflicts','agents','agent_versions',
    'live_agent','builder_sessions','calls','orders','bookings','integrations'];
  const deletable = ['builder_sessions','files','fact_conflicts','catalog_items','live_agent'];
  const tables = [...writable,'activity_events','webhook_events','capabilities','approval_requests','action_executions','message_dispatches','sync_jobs'];
  for (const table of tables) {
    const q = await db.query<{ ins:boolean; upd:boolean; del:boolean; trunc:boolean; sel:boolean; rls:boolean }>(`select
      has_table_privilege('abos_app',$1,'INSERT') ins, has_table_privilege('abos_app',$1,'UPDATE') upd,
      has_table_privilege('abos_app',$1,'DELETE') del, has_table_privilege('abos_app',$1,'TRUNCATE') trunc,
      has_table_privilege('abos_app',$1,'SELECT') sel, (select relrowsecurity from pg_class where oid=$1::regclass) rls`, ['public.'+table]);
    expect(q.rows[0], table).toEqual({ ins: writable.includes(table) || ['activity_events','webhook_events'].includes(table),
      upd:writable.includes(table),del:deletable.includes(table),trunc:false,sel:true,rls:true });
    const policies = await db.query<{cmd:string}>(`select cmd from pg_policies where tablename=$1 and 'abos_app'=any(roles)`, [table]);
    expect(policies.rows.map(p => p.cmd).sort()).toEqual(['SELECT', ...(q.rows[0]!.ins?['INSERT']:[]), ...(q.rows[0]!.upd?['UPDATE']:[]), ...(q.rows[0]!.del?['DELETE']:[])].sort());
  }
  const owner = await createOwner(db);
  await app(async () => {
    const f = await insert(db,'builder_sessions',{business_id:owner.businessId,owner_id:owner.userId});
    await db.query("update public.builder_sessions set status='completed' where id=$1",[f.id]);
    expect((await db.query('delete from public.builder_sessions where id=$1 returning id',[f.id])).rows).toHaveLength(1);
    expect((await db.query('select * from public.businesses where id=$1',[owner.businessId])).rows).toHaveLength(1);
    await insert(db,'activity_events',{business_id:owner.businessId,type:'agent.paused',actor_type:'owner',correlation_id:'test'});
  });
});

it('exposes only the checked entry points and pins definer search paths', async () => {
  const q = await db.query<{proname:string;prosecdef:boolean;proconfig:string[];runtime:boolean;browser:boolean;pub:boolean}>(`
    select p.proname,p.prosecdef,p.proconfig,has_function_privilege('abos_app',p.oid,'execute') runtime,
      has_function_privilege('authenticated',p.oid,'execute') browser,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') pub
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and proname<>'owns_business'`);
  const routines=['create_approval','decide_and_enqueue','claim_execution','claim_next_execution','finish_execution','record_dispatch',
    'update_dispatch','enqueue_sheets_sync','claim_sync_job','finish_sync_job','expire_approvals',
    'mark_order_paid','mark_order_payment_failed','recover_stale_executions'];
  for(const r of q.rows) {
    expect(r.runtime,r.proname).toBe(routines.includes(r.proname)); expect(r.browser).toBe(false); expect(r.pub).toBe(false);
    if(r.runtime) { expect(r.prosecdef).toBe(true); expect(r.proconfig).toContain('search_path=""'); }
  }
  expect(q.rows.filter(r=>r.runtime)).toHaveLength(14);
});

for(const type of types) describe(type, () => {
  it('creates, decides, enqueues, claims and finishes the exact bundle end to end', async () => {
    const p=await approved(type);
    const biz=p.owner.businessId;
    expect(p.approval.state).toBe('APPROVED');
    expect(p.executions.map(e=>e.action_type)).toEqual(p.args.actionBundle.filter(s=>!s.startsWith('sheets.')));
    const again=await app(()=>runtime.runtimeDecideAndEnqueue(db,p.decision));
    expect(again).toEqual({approval:p.approval,executions:p.executions});
    if(type==='order_bundle'||type==='booking_bundle') {
      const state=await db.query(`select status,approval_id from public.${type==='order_bundle'?'orders':'bookings'} where id=$1`,[p.args.subjectId]);
      expect(state.rows[0]).toEqual({status:type==='order_bundle'?'APPROVED':'RECHECKING_SLOT',approval_id:p.a.id});
    }
    for(const [index,e] of p.executions.entries()) {
      expect(e.idempotency_key).toBe(digest(`${biz}:${p.args.subjectId}:${e.action_type}:${p.a.id}`));
      await app(async()=>{
        const claimed=index===0 ? await runtime.runtimeClaimNextExecution(db,{businessId:biz,workerId:'worker'})
          : await runtime.runtimeClaimExecution(db,{businessId:biz,executionId:e.id,workerId:'worker'});
        expect(claimed?.id).toBe(e.id); expect(claimed?.status).toBe('RUNNING');
        expect(await runtime.runtimeClaimExecution(db,{businessId:biz,executionId:e.id,workerId:'other'})).toBeNull();
        if(e.action_type.startsWith('message.')) {
          const args={businessId:biz,executionId:e.id,workerId:'worker',attempt:1,bodyHash:hash('rendered message')};
          const d=await runtime.recordDispatch(db,args);
          expect(d.recipient).toBe((p.args.payload as Record<string,unknown>).messageRecipient); expect(d.channel).toBe('surge'); expect(d.idempotency_key).toBe(e.idempotency_key);
          expect((await runtime.recordDispatch(db,args)).id).toBe(d.id);
          const sent=await runtime.updateDispatch(db,{businessId:biz,dispatchId:d.id,workerId:'worker',attempt:1,status:'SENT',providerMessageId:'msg-'+uniq()});
          expect(sent.status).toBe('SENT');
          expect((await runtime.updateDispatch(db,{businessId:biz,dispatchId:d.id,workerId:'worker',attempt:1,status:'DELIVERED',providerMessageId:sent.provider_message_id})).status).toBe('DELIVERED');
          // A message step succeeds with its dispatch's provider message ID as the reference.
          expect((await runtime.finishExecution(db,{businessId:biz,executionId:e.id,workerId:'worker',attempt:1,status:'SUCCEEDED',externalRef:sent.provider_message_id})).status).toBe('SUCCEEDED');
          return;
        }
        expect((await finish(biz,e.id)).status).toBe('SUCCEEDED');
      });
    }
    if(type==='order_bundle'||type==='booking_bundle') {
      const recordType=type==='order_bundle'?'order':'booking';
      await app(async()=>{
        await expect(runtime.enqueueSheetsSync(db,{businessId:biz,recordType,recordId:p.args.subjectId})).rejects.toThrow(/SYNC/);
        if(recordType==='order') await db.query("update public.orders set status='PAID_VERIFIED',square_payment_id='pay',square_order_id='sq-'||id,square_payment_link_id='link-'||id,checkout_url='https://example.test/checkout' where id=$1",[p.args.subjectId]);
        else await db.query("update public.bookings set status='BOOKED_VERIFIED',google_event_id=$2 where id=$1",[p.args.subjectId,'event-'+uniq()]);
        const j=await runtime.enqueueSheetsSync(db,{businessId:biz,recordType,recordId:p.args.subjectId});
        expect((await runtime.enqueueSheetsSync(db,{businessId:biz,recordType,recordId:p.args.subjectId})).id).toBe(j.id);
        expect(j.idempotency_key).toBe(digest(`${biz}:${p.args.subjectId}:sheets.${recordType}.append:${p.a.id}`));
        expect((await runtime.claimSyncJob(db,{businessId:biz,syncJobId:j.id,workerId:'worker'}))?.state).toBe('RUNNING');
        expect((await runtime.finishSyncJob(db,{businessId:biz,syncJobId:j.id,workerId:'worker',attempt:1,state:'DONE',externalRef:'sheet-row'})).state).toBe('DONE');
      });
    }
  });
  it('rejects an empty canonical object and missing required material',async()=>{
    const p=await proposal(type);
    await app(async()=>{
      await expect(runtime.createApproval(db,{...p.args,canonical:'{}',payloadHash:hash('{}')})).rejects.toThrow(/MATERIAL/);
      const payload={...p.args.payload} as Record<string,unknown>; delete payload.expiresAt;
      await expect(runtime.createApproval(db,{...p.args,payload})).rejects.toThrow(/MATERIAL/);
    });
  });
  it('rejects a canonical subject different from the row subject',async()=>{
    const p=await proposal(type);
    const payload={...p.args.payload,subjectId:'another-subject'}; const canonical=JSON.stringify(payload);
    await app(()=>expect(runtime.createApproval(db,{...p.args,payload,canonical,payloadHash:hash(canonical)})).rejects.toThrow(/MATERIAL/));
  });
  it('rejects reordered signed arrays',async()=>{
    const p=await proposal(type);
    const altered=type==='fact_edit'?{...p.args.payload,before:{slots:[2,1]}}:
      {...p.args.payload,actionBundle:[...p.args.actionBundle].reverse()};
    // fact_edit has one action; its ordered nested material exercises array order instead.
    const canonical=JSON.stringify(altered);
    await app(()=>expect(runtime.createApproval(db,{...p.args,canonical,payloadHash:hash(canonical)})).rejects.toThrow(/MATERIAL/));
  });
});

it('refuses a decision after waiting past expiry inside the same transaction',async()=>{
  const p=await proposal('order_bundle','surge',500);
  const a=await app(()=>runtime.createApproval(db,p.args));
  await db.exec('begin; set local role abos_app');
  try {
    await db.query('select pg_sleep(0.55)');
    await expect(runtime.runtimeDecideAndEnqueue(db,{businessId:p.owner.businessId,approvalId:a.id,ownerUserId:p.owner.userId,payloadHash:a.payload_hash,decision:'APPROVED'})).rejects.toThrow(/EXPIRED/);
  } finally { await db.exec('rollback'); }
  expect((await db.query('select state from public.approval_requests where id=$1',[a.id])).rows[0]).toEqual({state:'PENDING'});
});

it('refuses wrong scope, wrong owner, wrong hash and conflicting repeats',async()=>{
  const p=await approved(); const other=await createOwner(db);
  await app(async()=>{
    await expect(runtime.runtimeDecideAndEnqueue(db,{...p.decision,businessId:other.businessId})).rejects.toThrow(/SCOPE/);
    await expect(runtime.runtimeDecideAndEnqueue(db,{...p.decision,ownerUserId:other.userId})).rejects.toThrow(/OWNER/);
    await expect(runtime.runtimeDecideAndEnqueue(db,{...p.decision,payloadHash:hash('other')})).rejects.toThrow(/HASH/);
    await expect(runtime.runtimeDecideAndEnqueue(db,{...p.decision,decision:'REJECTED'})).rejects.toThrow(/DECIDED/);
  });
});

it('refuses queued completion, predecessor regression, stale leases and dispatches for queued steps',async()=>{
  const p=await approved(); const biz=p.owner.businessId; const e=p.executions;
  await app(async()=>{
    await expect(finish(biz,e[0]!.id)).rejects.toThrow(/LEASE/);
    await expect(runtime.recordDispatch(db,{businessId:biz,executionId:e[1]!.id,workerId:'worker',attempt:0,bodyHash:hash('body')})).rejects.toThrow(/LEASE/);
    await runtime.runtimeClaimExecution(db,{businessId:biz,executionId:e[0]!.id,workerId:'worker'});
    await expect(finish(biz,e[0]!.id,1,'wrong')).rejects.toThrow(/LEASE/);
    await finish(biz,e[0]!.id,1,'worker','QUEUED');
    await runtime.runtimeClaimExecution(db,{businessId:biz,executionId:e[0]!.id,workerId:'worker'});
    await expect(finish(biz,e[0]!.id,1)).rejects.toThrow(/LEASE/);
    await finish(biz,e[0]!.id,2);
    await runtime.runtimeClaimExecution(db,{businessId:biz,executionId:e[1]!.id,workerId:'worker'});
    await expect(finish(biz,e[0]!.id,2,'worker','QUEUED')).rejects.toThrow(/LEASE|PREDECESSOR/);
    await expect(db.query("update public.action_executions set status=case when id=$1 then 'QUEUED' else 'RUNNING' end where id in ($1,$2)",[e[0]!.id,e[1]!.id])).rejects.toMatchObject({code:'42501'});
    const d=await runtime.recordDispatch(db,{businessId:biz,executionId:e[1]!.id,workerId:'worker',attempt:1,bodyHash:hash('body')});
    await expect(runtime.recordDispatch(db,{businessId:biz,executionId:e[1]!.id,workerId:'worker',attempt:1,bodyHash:hash('different body')})).rejects.toThrow(/IDENTITY/);
    await expect(runtime.updateDispatch(db,{businessId:biz,dispatchId:d.id,workerId:'wrong',attempt:1,status:'SENT',providerMessageId:'msg'})).rejects.toThrow(/LEASE/);
    await expect(db.query('delete from public.message_dispatches where id=$1',[d.id])).rejects.toMatchObject({code:'42501'});
    await expect(db.query('delete from public.action_executions where id=$1',[e[0]!.id])).rejects.toMatchObject({code:'42501'});
    await expect(db.query("insert into public.action_executions(business_id,approval_id,action_type,step_index,idempotency_key) values($1,$2,'square.checkout.create',0,$3)",[biz,p.a.id,digest('caller key')])).rejects.toMatchObject({code:'42501'});
  });
});

it('refuses Sheets for nonexistent, unapproved and cross-business subjects',async()=>{
  const p=await proposal(); const other=await createOwner(db);
  await app(async()=>{
    for(const [businessId,recordId] of [[p.owner.businessId,'nonexistent'],[p.owner.businessId,p.args.subjectId],[other.businessId,p.args.subjectId]])
      await expect(runtime.enqueueSheetsSync(db,{businessId:businessId!,recordType:'order',recordId:recordId!})).rejects.toThrow(/SYNC/);
  });
});

it('skips only the qr_only message and creates no dispatch',async()=>{
  const p=await approved('order_bundle','qr_only');
  expect(p.executions.map(e=>e.status)).toEqual(['QUEUED','SKIPPED','QUEUED']);
  await app(async()=>{
    await expect(runtime.recordDispatch(db,{businessId:p.owner.businessId,executionId:p.executions[1]!.id,workerId:'worker',attempt:0,bodyHash:hash('body')})).rejects.toThrow(/LEASE/);
    expect((await runtime.runtimeClaimExecution(db,{businessId:p.owner.businessId,executionId:p.executions[0]!.id,workerId:'worker'}))?.status).toBe('RUNNING');
    await finish(p.owner.businessId,p.executions[0]!.id);
    expect((await runtime.runtimeClaimNextExecution(db,{businessId:p.owner.businessId,workerId:'worker'}))?.step_index).toBe(2);
  });
});

it('repairs a historical decision with zero steps, then repeats without changes',async()=>{
  const p=await proposal(); const a=await app(()=>runtime.createApproval(db,p.args));
  const decision={businessId:p.owner.businessId,approvalId:a.id,ownerUserId:p.owner.userId,payloadHash:a.payload_hash,decision:'APPROVED' as const};
  await decideApproval(db,decision); // Historical administrator-only compatibility path.
  const result=await app(()=>runtime.runtimeDecideAndEnqueue(db,decision));
  expect(result.executions).toHaveLength(3);
  expect(await app(()=>runtime.runtimeDecideAndEnqueue(db,decision))).toEqual(result);
});

it('ALWAYS delete and sync identity guards protect even the migration owner in replica mode',async()=>{
  const p=await approved(); const e=p.executions[0]!;
  const j=await insert(db,'sync_jobs',{business_id:p.owner.businessId,target:'google_sheets',record_type:'order',record_id:p.args.subjectId});
  await db.exec('set session_replication_role=replica');
  try {
    await expect(db.query('delete from public.action_executions where id=$1',[e.id])).rejects.toThrow(/RETAIN/);
    await expect(db.query('delete from public.sync_jobs where id=$1',[j.id])).rejects.toThrow(/RETAIN/);
    await expect(db.query("update public.sync_jobs set record_id='different' where id=$1",[j.id])).rejects.toThrow(/IDENTITY/);
  } finally { await db.exec('set session_replication_role=origin'); }
  for(const table of ['approval_requests','action_executions','message_dispatches','sync_jobs']) {
    expect((await db.query(`select has_table_privilege('service_role',$1,'DELETE') d,has_table_privilege('service_role',$1,'TRUNCATE') t`,['public.'+table])).rows[0]).toEqual({d:false,t:false});
  }
});

it('quotes the operator password as a literal and never leaks it through errors',async()=>{
  const password="x'\\; ALTER ROLE abos_app SUPERUSER; --";
  await runtime.enableRuntimeLogin(db,password);
  expect((await db.query("select rolcanlogin,rolsuper from pg_roles where rolname='abos_app'")).rows[0]).toEqual({rolcanlogin:true,rolsuper:false});
  const bad={query:async()=>{throw new Error(password);}};
  await expect(runtime.enableRuntimeLogin(bad,password)).rejects.toThrow(/^Could not enable runtime login$/);
  await db.exec('alter role abos_app nologin password null');
});


for(const type of ['order_bundle','booking_bundle'] as const) {
  it(`${type}: rejects the subject atomically, writes one audit and repeats unchanged`,async()=>{
    const p=await proposal(type); const a=await app(()=>runtime.createApproval(db,p.args));
    const decision={businessId:p.owner.businessId,approvalId:a.id,ownerUserId:p.owner.userId,payloadHash:a.payload_hash,decision:'REJECTED' as const};
    const first=await app(()=>runtime.runtimeDecideAndEnqueue(db,decision));
    expect(first.executions).toEqual([]);
    expect(await app(()=>runtime.runtimeDecideAndEnqueue(db,decision))).toEqual(first);
    expect((await db.query(`select status from public.${type==='order_bundle'?'orders':'bookings'} where id=$1`,[p.args.subjectId])).rows[0]).toEqual({status:'REJECTED'});
    expect((await db.query("select count(*)::int n from public.activity_events where correlation_id=$1 and type='approval.decided'",[a.id])).rows[0]).toEqual({n:1});
  });
  it(`${type}: sweeps by wall clock in an old transaction and moves only its own business`,async()=>{
    const p=await proposal(type,'surge',500); const a=await app(()=>runtime.createApproval(db,p.args));
    await db.exec('begin; set local role abos_app');
    try {
      await db.query('select pg_sleep(0.55)');
      expect(await runtime.runtimeExpireApprovals(db,'different-business')).toEqual([]);
      const swept=await runtime.runtimeExpireApprovals(db,p.owner.businessId);
      expect(swept.map(x=>x.id)).toEqual([a.id]); expect(swept[0]?.subject_moved).toBe(true);
      expect(await runtime.runtimeExpireApprovals(db,p.owner.businessId)).toEqual([]);
      expect((await db.query(`select status from public.${type==='order_bundle'?'orders':'bookings'} where id=$1`,[p.args.subjectId])).rows[0])
        .toEqual({status:type==='order_bundle'?'APPROVAL_EXPIRED':'EXPIRED'});
    } finally { await db.exec('rollback'); }
  });
}

it('stops retries at three attempts and never changes a finished result',async()=>{
  const p=await approved('fact_edit'); const id=p.executions[0]!.id; const businessId=p.owner.businessId;
  await app(async()=>{
    for(let attempt=1;attempt<=3;attempt++) {
      const claimed=await runtime.runtimeClaimExecution(db,{businessId,executionId:id,workerId:'worker'});
      expect(claimed?.attempts).toBe(attempt);
      if(attempt<3) await finish(businessId,id,attempt,'worker','QUEUED');
      else {
        await expect(finish(businessId,id,attempt,'worker','QUEUED')).rejects.toThrow(/RETRY/);
        expect((await runtime.finishExecution(db,{businessId,executionId:id,workerId:'worker',attempt,status:'FAILED',error:'provider refused'})).status).toBe('FAILED');
      }
    }
    expect(await runtime.runtimeClaimExecution(db,{businessId,executionId:id,workerId:'worker'})).toBeNull();
    await expect(finish(businessId,id,3)).rejects.toThrow(/LEASE/);
  });
});

it('revalidates current material on claim and does not accept caller chosen keys or routing',async()=>{
  const p=await approved(); const businessId=p.owner.businessId;
  await app(async()=>{
    await db.query('update public.orders set total_minor=9999 where id=$1',[p.args.subjectId]);
    await expect(runtime.runtimeClaimExecution(db,{businessId,executionId:p.executions[0]!.id,workerId:'worker'})).rejects.toThrow(/SUBJECT/);
    await expect(db.query('select private.decide_and_enqueue($1,$2,$3,$4,$5,$6,$7)',[businessId,p.a.id,p.owner.userId,p.a.payload_hash,'APPROVED',null,'caller-key'])).rejects.toThrow(/does not exist/);
    await expect(db.query('select private.record_dispatch($1,$2,$3,$4,$5,$6)',[businessId,p.executions[1]!.id,'worker',1,hash('body'),'+19999999999'])).rejects.toThrow(/does not exist/);
  });
});

it('repairs an exact missing suffix and preserves the original execution and audit',async()=>{
  const p=await proposal('price_edit'); const a=await app(()=>runtime.createApproval(db,p.args));
  const decision={businessId:p.owner.businessId,approvalId:a.id,ownerUserId:p.owner.userId,payloadHash:a.payload_hash,decision:'APPROVED' as const};
  await decideApproval(db,decision);
  const key=digest(`${p.owner.businessId}:${p.args.subjectId}:square.catalog.price.update:${a.id}`);
  const e=await insert(db,'action_executions',{business_id:p.owner.businessId,approval_id:a.id,action_type:'square.catalog.price.update',step_index:0,idempotency_key:key});
  const result=await app(()=>runtime.runtimeDecideAndEnqueue(db,decision));
  expect(result.executions).toHaveLength(2); expect(result.executions[0]?.id).toBe(e.id);
  const repeat=await app(()=>runtime.runtimeDecideAndEnqueue(db,decision)); expect(repeat).toEqual(result);
  expect((await db.query("select count(*)::int n from public.activity_events where correlation_id=$1 and type='approval.decided'",[a.id])).rows[0]).toEqual({n:1});
});

it('retains a SENT dispatch against delete/reinsert even for the owner in replica mode',async()=>{
  const p=await approved(); const businessId=p.owner.businessId;
  const d=await app(async()=>{
    await runtime.runtimeClaimExecution(db,{businessId,executionId:p.executions[0]!.id,workerId:'worker'});
    await finish(businessId,p.executions[0]!.id);
    await runtime.runtimeClaimExecution(db,{businessId,executionId:p.executions[1]!.id,workerId:'worker'});
    const created=await runtime.recordDispatch(db,{businessId,executionId:p.executions[1]!.id,workerId:'worker',attempt:1,bodyHash:hash('body')});
    const result=await runtime.updateDispatch(db,{businessId,dispatchId:created.id,workerId:'worker',attempt:1,status:'SENT',providerMessageId:'provider-'+uniq()});
    await expect(db.query('delete from public.message_dispatches where id=$1',[created.id])).rejects.toMatchObject({code:'42501'});
    await expect(db.query(`insert into public.message_dispatches(business_id,approval_id,execution_id,order_id,channel,recipient,template,body_hash,idempotency_key)
      values($1,$2,$3,$4,'surge','+15555550123','checkout_link',$5,'another-key')`,[businessId,p.a.id,p.executions[1]!.id,p.args.subjectId,hash('different')])).rejects.toMatchObject({code:'42501'});
    return result;
  });
  await db.exec('set session_replication_role=replica');
  try { await expect(db.query('delete from public.message_dispatches where id=$1',[d.id])).rejects.toThrow(/RETAIN/); }
  finally { await db.exec('set session_replication_role=origin'); }
});

it('rechecks sync eligibility, fences worker attempts and enforces five attempts',async()=>{
  const p=await approved('booking_bundle'); const businessId=p.owner.businessId;
  await app(async()=>{
    await db.query("update public.bookings set status='BOOKED_VERIFIED',google_event_id=$2 where id=$1",[p.args.subjectId,'event-'+uniq()]);
    const j=await runtime.enqueueSheetsSync(db,{businessId,recordType:'booking',recordId:p.args.subjectId});
    await db.query("update public.bookings set status='RETRY_REQUIRED' where id=$1",[p.args.subjectId]);
    await expect(runtime.claimSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker'})).rejects.toThrow(/SYNC/);
    await db.query("update public.bookings set status='BOOKED_VERIFIED' where id=$1",[p.args.subjectId]);
    await expect(runtime.finishSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker',attempt:0,state:'DONE',externalRef:'row'})).rejects.toThrow(/LEASE/);
    for(let attempt=1;attempt<=5;attempt++) {
      expect((await runtime.claimSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker'}))?.attempts).toBe(attempt);
      await expect(runtime.finishSyncJob(db,{businessId,syncJobId:j.id,workerId:'wrong',attempt,state:'DONE',externalRef:'row'})).rejects.toThrow(/LEASE/);
      if(attempt>1) await expect(runtime.finishSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker',attempt:attempt-1,state:'DONE',externalRef:'row'})).rejects.toThrow(/LEASE/);
      if(attempt===5) {
        await expect(runtime.finishSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker',attempt,state:'RETRYING',retryAt:new Date(0)})).rejects.toThrow(/RETRY/);
        await runtime.finishSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker',attempt,state:'FAILED'});
      } else await runtime.finishSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker',attempt,state:'RETRYING',retryAt:new Date(0)});
    }
    expect(await runtime.claimSyncJob(db,{businessId,syncJobId:j.id,workerId:'worker'})).toBeNull();
  });
});

it('refuses historical sync jobs without the approved derived identity',async()=>{
  const p=await approved('booking_bundle');
  await db.query("update public.bookings set status='BOOKED_VERIFIED',google_event_id=$2 where id=$1",[p.args.subjectId,'event-'+uniq()]);
  const j=await insert(db,'sync_jobs',{business_id:p.owner.businessId,target:'google_sheets',record_type:'booking',record_id:p.args.subjectId});
  await app(()=>expect(runtime.claimSyncJob(db,{businessId:p.owner.businessId,syncJobId:String(j.id),workerId:'worker'})).rejects.toThrow(/IDENTITY/));
});

it('binds material fields to their stored subject and rejects cross-business proposals',async()=>{
  const p=await proposal(); const other=await createOwner(db);
  const payload={...p.args.payload,businessId:other.businessId}; const canonical=JSON.stringify(payload);
  await app(async()=>{
    await expect(runtime.createApproval(db,{...p.args,businessId:other.businessId,payload,canonical,payloadHash:hash(canonical)})).rejects.toThrow(/SUBJECT/);
    const wrong={...p.args.payload,totalMinor:9999}; const text=JSON.stringify(wrong);
    await expect(runtime.createApproval(db,{...p.args,payload:wrong,canonical:text,payloadHash:hash(text)})).rejects.toThrow(/SUBJECT/);
    const unbound={...p.args.payload,expiresAt:new Date(Date.now()+100_000).toISOString()}; const unboundText=JSON.stringify(unbound);
    await expect(runtime.createApproval(db,{...p.args,payload:unbound,canonical:unboundText,payloadHash:hash(unboundText)})).rejects.toThrow(/MATERIAL/);
  });
});

it('rolls back the decision, subject and audit if enqueue detects conflicting historical identity',async()=>{
  const p=await proposal(); const a=await app(()=>runtime.createApproval(db,p.args));
  // An administrator plants an impossible historical row; runtime routines must not bless it.
  await db.exec('alter table public.action_executions disable trigger action_executions_match_approval');
  try {
    await insert(db,'action_executions',{business_id:p.owner.businessId,approval_id:a.id,action_type:'square.checkout.create',step_index:0,idempotency_key:digest('wrong')});
  } finally { await db.exec('alter table public.action_executions enable always trigger action_executions_match_approval'); }
  await app(()=>expect(runtime.runtimeDecideAndEnqueue(db,{businessId:p.owner.businessId,approvalId:a.id,ownerUserId:p.owner.userId,payloadHash:a.payload_hash,decision:'APPROVED'})).rejects.toThrow(/IDENTITY/));
  expect((await db.query('select state from public.approval_requests where id=$1',[a.id])).rows[0]).toEqual({state:'PENDING'});
  expect((await db.query('select status from public.orders where id=$1',[p.args.subjectId])).rows[0]).toEqual({status:'AWAITING_OWNER_APPROVAL'});
  expect((await db.query('select count(*)::int n from public.activity_events where correlation_id=$1',[a.id])).rows[0]).toEqual({n:0});
});

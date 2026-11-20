import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { p0Environment,p0Pool,verifyInstance,logEvent } from '@hsbc/server/experiments/p0/persistence/environment';
import { P0Store } from '@hsbc/server/experiments/p0/persistence/store';
import { P0Runner } from '@hsbc/workflows/experiments/p0/queue';
class WorkerModule {}
Module({})(WorkerModule);
export async function createWorker() {
  const env=p0Environment();const pool=p0Pool(env.WORKER_DATABASE_URL),checkpoint=p0Pool(env.CHECKPOINT_DATABASE_URL);
  await verifyInstance(pool,env.P0_INSTANCE_ID);await verifyInstance(checkpoint,env.P0_INSTANCE_ID);
  const context=await NestFactory.createApplicationContext(WorkerModule,{logger:false});
  const runner=new P0Runner(new P0Store(pool),checkpoint,env.REDIS_URL,`p0-${env.P0_INSTANCE_ID}`);
  await runner.start();
  return {close:async()=>{await runner.close();await pool.end();await checkpoint.end();await context.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const runtime=await createWorker();let closing=false;
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;void runtime.close().then(()=>process.exit(0));});
  logEvent('p0_worker_ready');
}

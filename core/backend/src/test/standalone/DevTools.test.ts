/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
import { Logger, LogLevel } from "@bentley/bentleyjs-core";
import { DevTools, DevToolsStatsFormatter } from "../../imodeljs-backend";
import { assert } from "chai";
import { IModelTestUtils } from "../IModelTestUtils";
import * as os from "os";

interface StringIndexedObject<T> {
  [index: string]: T;
}

describe("DevTools", () => {

  before(async () => {
    IModelTestUtils.setupLogging();
  });

  it("can fetch stats from backend", () => {
    const stats = DevTools.stats();
    assert.isDefined(stats);
    assert.isDefined(stats.os);
    assert.isDefined(stats.os.totalmem);
    assert.isDefined(stats.os.freemem);
    assert.isDefined(stats.os.uptime);
    assert.isDefined(stats.os.cpus);
    assert.isDefined(stats.os.cpuUsage);
    assert.isTrue(stats.os.cpuUsage < 100);
    assert.isDefined(stats.process);
    assert.isDefined(stats.process.pid);
    assert.isDefined(stats.process.ppid);
    assert.isDefined(stats.process.memoryUsage);
    assert.isDefined(stats.process.uptime);

    assert.isTrue(Object.keys(stats.os.cpus).length > 0);
    for (const cpu of Object.values<os.CpuInfo>(stats.os.cpus)) {
      assert.isDefined(cpu.times);
      const cpuTimes = cpu.times as StringIndexedObject<number>;
      assert.isTrue(Object.keys(cpuTimes).length > 0);
    }
  });

  it("can serialize stats from backend appropriately", () => {
    const stats = DevTools.stats();
    const formattedStats = DevToolsStatsFormatter.toFormattedJson(stats);

    assert.isTrue((formattedStats.os.totalmem as string).endsWith("MB"));
    assert.isTrue((formattedStats.os.freemem as string).endsWith("MB"));
    assert.isTrue((formattedStats.os.uptime as string).endsWith("secs"));
    assert.isTrue((formattedStats.os.cpus[0].speed as string).endsWith("MHz"));
    assert.isTrue((formattedStats.os.cpus[0].times.user as string).endsWith("%"));
    assert.isTrue((formattedStats.os.cpus[0].times.nice as string).endsWith("%"));
    assert.isTrue((formattedStats.os.cpus[0].times.sys as string).endsWith("%"));
    assert.isTrue((formattedStats.os.cpus[0].times.idle as string).endsWith("%"));
    assert.isTrue((formattedStats.os.cpus[0].times.irq as string).endsWith("%"));
    assert.isTrue((formattedStats.os.cpuUsage! as string).endsWith("%"));

    assert.isTrue((formattedStats.process.uptime as string).endsWith("secs"));
    assert.isTrue((formattedStats.process.memoryUsage.rss as string).endsWith("MB"));
    assert.isTrue((formattedStats.process.memoryUsage.heapTotal as string).endsWith("MB"));
    assert.isTrue((formattedStats.process.memoryUsage.heapUsed as string).endsWith("MB"));
    assert.isTrue((formattedStats.process.memoryUsage.external as string).endsWith("MB"));
  });

  it("can ping backend", () => {
    const ret = DevTools.ping();
    assert.isTrue(ret);
  });

  it("can set log level", () => {
    const loggerCategory = "test-category";

    const expectedOldLevel = LogLevel.Info;
    Logger.setLevel(loggerCategory, expectedOldLevel);

    const expectedNewLevel = LogLevel.Warning;
    const actualOldLevel = DevTools.setLogLevel(loggerCategory, expectedNewLevel);
    assert.equal(actualOldLevel, expectedOldLevel);

    const actualNewLevel = Logger.getLevel(loggerCategory);
    assert.equal(actualNewLevel, expectedNewLevel);
  });

  it("Get the backend versions", () => {
    const versions = DevTools.versions();
    assert.isDefined(versions.application);
    assert.isDefined(versions.iModelJs);
  });
});

describe.skip("DevTools is able to signal the backend", () => {

  before(async () => {
    IModelTestUtils.setupLogging();
  });

  it("None", () => {
    DevTools.signal(0);
  });

  it("Abort", () => {
    DevTools.signal(1);
  });

  it("RaiseSigSev", () => {
    DevTools.signal(2);
  });

  it("DereferenceNull", () => {
    DevTools.signal(3);
  });

  it("DivideByZero", () => {
    DevTools.signal(4);
  });

  it("StackOverflow", () => {
    DevTools.signal(5);
  });

  it("ThreadDeadlock", () => {
    DevTools.signal(6);
  });
});

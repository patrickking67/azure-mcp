import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, splitCommand } from "../dist/cli-policy.js";

const tier = (cmd) => classify(splitCommand(cmd));

test("reads stay reads", () => {
  for (const cmd of ["vm list", "vm show -g rg -n vm", "account list-locations", "aks get-upgrades -g rg -n c", "storage account check-name-availability -n x", "rest --uri /subscriptions?api-version=2022-12-01", "keyvault secret list --vault-name v"]) {
    assert.equal(tier(cmd).tier, "read", cmd);
    assert.equal(tier(cmd).blocked, undefined, cmd);
  }
});

test("writes and destructive verbs are classified", () => {
  assert.equal(tier("group create -n rg -l eastus").tier, "write");
  assert.equal(tier("vm start -g rg -n vm").tier, "write");
  for (const cmd of ["group delete -n rg --yes", "vm deallocate -g rg -n vm", "webapp restart -g rg -n app", "keyvault purge -n v", "storage account keys renew -n x", "rest --method delete --uri /subscriptions/x", "aks upgrade -g rg -n c"]) {
    assert.ok(["destructive", "write"].includes(tier(cmd).tier), cmd);
  }
  assert.equal(tier("group delete -n rg").tier, "destructive");
  assert.equal(tier("rest --method delete --uri /x").tier, "destructive");
  assert.equal(tier("rest --method put --uri /x --body {}").tier, "write");
});

test("credential reads are sensitive and never read-tier", () => {
  for (const cmd of ["storage account keys list -n x", "redis list-keys -n x -g rg", "aks get-credentials -g rg -n c", "storage account show-connection-string -n x", "webapp config appsettings list -g rg -n a", "keyvault secret show --vault-name v -n s", "acr credential show -n r"]) {
    const c = tier(cmd);
    assert.equal(c.sensitive, true, cmd);
    assert.equal(c.tier, "write", cmd);
  }
});

test("blocked commands and arguments", () => {
  for (const cmd of ["login", "account set -s x", "account get-access-token", "config set core.output=table", "extension add -n foo", "upgrade", "webapp log tail -n a -g rg", "ssh vm -n v -g rg", "vm list --debug", "rest --url /x --body @secrets.json", "deployment group create -g rg --parameters p=@file.json", "rest --url https://evil.example.com/x", "rest --url http://management.azure.com/x"]) {
    assert.ok(tier(cmd).blocked, cmd);
  }
});

test("splitCommand handles quotes and a leading az", () => {
  assert.deepEqual(splitCommand(`az vm list --query "[?name=='a b']"`), ["vm", "list", "--query", "[?name=='a b']"]);
  assert.deepEqual(splitCommand("group list -o 'table'"), ["group", "list", "-o", "table"]);
  assert.throws(() => splitCommand('vm list --query "oops'));
});

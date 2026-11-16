// The schedule grammar (`every 15m`, 5-field cron) belongs to the bundled schedule trigger, moss/trigger-schedule
// (spec §7 "triggers are plugins"); the routine engine runs that plugin's code in-process. Owner: lane D.
export * from "../../../../plugins/moss/plugins/trigger-schedule/src/spec";

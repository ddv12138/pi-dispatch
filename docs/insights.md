# Spend and insights

The [operator console](console.md) has Spend, Budget split, Capacity, Breakdown and Flows views. Choose a range and project where offered; Capacity covers the fleet. History is limited by retention and the 92-day scan cap. Missing, truncated and newer-version records are identified rather than counted as zero.

## Settled, held and caps

Settled amounts come from run records; holds are live workers' reservations. Incomplete holds and differences from enforcement counters are identified. A prepaid plan changes reporting, not enforcement: jobs still count against caps at API-equivalent prices. See [cost accounting](costs.md).

## What-if estimates

Choose a model on Spend to reprice eligible runs, or use Breakdown to estimate one flow. Estimates name their coverage and exclusions; a different model may need more turns or fail more often. `/dispatch insights [7d|30d|mtd]` and `/dispatch insights whatif <provider>/<model> --flow <flow>` print the corresponding console links.

## Budget split actions

An operator can preview and confirm priorities, envelope changes and reverts. Distribute a changed envelope file to every host: a host with a different envelope refuses governed jobs. Viewers cannot change the split. See [allocation](allocation.md).

## Flows map and paths

The Flows view shows configured trigger edges, observed chains and potential mentions. A mention is not a promise that a flow will run. Local paths are basenames unless an operator requests full paths; viewers only see basenames. The `view=list` option works without the map.

## The capacity section

Capacity shows fleet and host utilization, waits, memory and CPU sizing. The selected window and gaps in coverage are shown with the report.

## The job sizes section

Compare a run's resource use with its assigned size before changing limits. See [sizing jobs](sizing.md).

## What each run records about resources

A run may record peak memory, swap and process counts, memory pressure, CPU use and throttling. Fields can be null when the venue or job image cannot report them. These measurements come from inside the job container and are advisory; the operator confirms any suggested size change. Disk and network use are not measured. See [job sizes](scoped-limits.md#job-sizes-version-3).

## Pi dispatch capacity

Capacity reports are deployment-wide and cannot distinguish work outside pi-dispatch on the same machine.

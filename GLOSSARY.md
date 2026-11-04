# Glossary

**Mechanic Time**: Hours a mechanic logs on an E360 time card for repairing or servicing equipment, a job, or the shop. Split into regular, overtime and double-time hours.
_Avoid_: operator hours, equipment hours (those are HeavyJob run-time on jobs)

**Unit**: One piece of equipment in E360, identified by its equipment code. Mechanic Time is totalled per Unit.
_Avoid_: asset, machine

**Unit Time**: Mechanic Time whose work type is Equipment, so it belongs to exactly one Unit.

**Shop Time**: Mechanic Time whose work type is Shop (cleanup, shop tasks). Not tied to any Unit.

**Job Time**: Mechanic Time whose work type is Job (work billed to a job rather than to a Unit). Not tied to any Unit.

**Equipment Manager**: The person who reviews Mechanic Time per Unit. Together with the other allowlisted staff, they are the connector's users.

**Counted Time**: Mechanic Time on cards whose status is not rejected, and whose entries are not voided. Totals use Counted Time unless asked for approved-only.

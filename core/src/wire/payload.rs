//! Closed wire payload types matching the versioned contracts.
use super::Optional;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalSchema {
    #[serde(rename = "action_proposal/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalBasedOnFrame {
    pub sha256: String,
    pub generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase0Type {
    #[serde(rename = "click")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase0Button {
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "middle")]
    Middle,
    #[serde(rename = "right")]
    Right,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase0 {
    pub r#type: ActionProposalActionCase0Type,
    pub x: u64,
    pub y: u64,
    pub button: ActionProposalActionCase0Button,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase1Type {
    #[serde(rename = "key")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase1 {
    pub r#type: ActionProposalActionCase1Type,
    pub keys: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase2Type {
    #[serde(rename = "type")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase2 {
    pub r#type: ActionProposalActionCase2Type,
    pub text: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase3Type {
    #[serde(rename = "scroll")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase3 {
    pub r#type: ActionProposalActionCase3Type,
    pub dx: i64,
    pub dy: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase4Type {
    #[serde(rename = "wait")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase4 {
    pub r#type: ActionProposalActionCase4Type,
    pub ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalActionCase5Type {
    #[serde(rename = "lane_submit")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase5Payload {
    pub nonce: String,
    pub seq: u64,
    pub command: String,
    pub args: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalActionCase5 {
    pub r#type: ActionProposalActionCase5Type,
    pub verb: String,
    pub payload: ActionProposalActionCase5Payload,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionProposalAction {
    Case0(Box<ActionProposalActionCase0>),
    Case1(Box<ActionProposalActionCase1>),
    Case2(Box<ActionProposalActionCase2>),
    Case3(Box<ActionProposalActionCase3>),
    Case4(Box<ActionProposalActionCase4>),
    Case5(Box<ActionProposalActionCase5>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalExpectationCase0Type {
    #[serde(rename = "changed_region")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalExpectationCase0Bbox {
    pub x: u64,
    pub y: u64,
    pub w: u64,
    pub h: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalExpectationCase0 {
    pub r#type: ActionProposalExpectationCase0Type,
    pub bbox: ActionProposalExpectationCase0Bbox,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalExpectationCase1Type {
    #[serde(rename = "element_state")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalExpectationCase1 {
    pub r#type: ActionProposalExpectationCase1Type,
    pub role: String,
    pub name: String,
    pub state: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalExpectationCase2Type {
    #[serde(rename = "state_sha256_change")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalExpectationCase2 {
    pub r#type: ActionProposalExpectationCase2Type,
    pub before: String,
    pub min_tick: u64,
    pub max_tick: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionProposalExpectationCase3Type {
    #[serde(rename = "text_present")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalExpectationCase3 {
    pub r#type: ActionProposalExpectationCase3Type,
    pub text: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionProposalExpectation {
    Case0(Box<ActionProposalExpectationCase0>),
    Case1(Box<ActionProposalExpectationCase1>),
    Case2(Box<ActionProposalExpectationCase2>),
    Case3(Box<ActionProposalExpectationCase3>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposalBudget {
    pub max_ms: u64,
    pub max_retries: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposal {
    pub schema: ActionProposalSchema,
    pub proposal_id: String,
    pub surface_id: String,
    pub based_on_frame: ActionProposalBasedOnFrame,
    pub action: ActionProposalAction,
    pub expectation: ActionProposalExpectation,
    pub budget: ActionProposalBudget,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionReceiptSchema {
    #[serde(rename = "action_receipt/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrameRefSchema {
    #[serde(rename = "frame_ref/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrameRefFormat {
    #[serde(rename = "rgb24")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameRef {
    pub schema: FrameRefSchema,
    pub surface_id: String,
    pub generation: u64,
    pub tick: u64,
    pub ts_ns: u64,
    pub width: u64,
    pub height: u64,
    pub format: FrameRefFormat,
    pub ramws_path: String,
    pub sha256: String,
    pub capture_us: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionReceiptVerificationMethod {
    #[serde(rename = "pixel")]
    Pixel,
    #[serde(rename = "element")]
    Element,
    #[serde(rename = "state_sha256")]
    StateSha256,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptVerification {
    pub method: ActionReceiptVerificationMethod,
    pub detail: String,
}
// [TARGET, unit decision] Native evidence is optional for older receipts;
// absent focus proof remains distinct from false and never verifies success.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeInputEvidence {
    pub surface_id: String,
    pub input_mono_ns: u64,
    pub input_ts_ns: u64,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub native_surface_id: Optional<String>,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub kind: Optional<NativeInputKind>,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub focus_verified: Optional<bool>,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub result: Optional<NativeInputResult>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeInputKind {
    Click,
    Key,
    Text,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum NativeInputResult {
    #[serde(rename = "ok")]
    Ok,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceipt {
    pub schema: ActionReceiptSchema,
    pub proposal_id: String,
    pub executed_at_ns: u64,
    pub after_frame: FrameRef,
    pub verified: bool,
    pub verification: ActionReceiptVerification,
    pub error: String,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub native_evidence: Optional<NativeInputEvidence>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionVerdictCase0Schema {
    #[serde(rename = "action_verdict/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionVerdictCase0Decision {
    #[serde(rename = "refused")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionVerdictCase0ReasonCode {
    #[serde(rename = "STALE_FRAME")]
    STALEFRAME,
    #[serde(rename = "SURFACE_NOT_AGENT_CONTROLLED")]
    SURFACENOTAGENTCONTROLLED,
    #[serde(rename = "LOCKED_BY_OTHER")]
    LOCKEDBYOTHER,
    #[serde(rename = "BUDGET_EXCEEDED")]
    BUDGETEXCEEDED,
    #[serde(rename = "OUT_OF_BOUNDS")]
    OUTOFBOUNDS,
    #[serde(rename = "POLICY")]
    POLICY,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionVerdictCase0 {
    pub schema: ActionVerdictCase0Schema,
    pub proposal_id: String,
    pub decision: ActionVerdictCase0Decision,
    pub reason_code: ActionVerdictCase0ReasonCode,
    pub core_seq: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionVerdictCase1Decision {
    #[serde(rename = "admitted")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionVerdictCase1 {
    pub schema: ActionVerdictCase0Schema,
    pub proposal_id: String,
    pub decision: ActionVerdictCase1Decision,
    pub core_seq: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionVerdict {
    Case0(Box<ActionVerdictCase0>),
    Case1(Box<ActionVerdictCase1>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CapsuleMetaSchema {
    #[serde(rename = "capsule_meta/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CapsuleMetaKind {
    #[serde(rename = "browser")]
    Browser,
    #[serde(rename = "program")]
    Program,
    #[serde(rename = "desktop_capsule")]
    DesktopCapsule,
    #[serde(rename = "game_capsule")]
    GameCapsule,
    #[serde(rename = "vm")]
    Vm,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapsuleMetaWindowsItem {
    pub window_id: String,
    pub x_px: u64,
    pub y_px: u64,
    pub width_px: u64,
    pub height_px: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapsuleMeta {
    pub schema: CapsuleMetaSchema,
    pub surface_id: String,
    pub kind: CapsuleMetaKind,
    pub container: String,
    pub run_id: String,
    pub display: String,
    pub fb_path: String,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub lane_socket: Optional<String>,
    pub ready_line: String,
    pub windows: Vec<CapsuleMetaWindowsItem>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CatalogEntrySchema {
    #[serde(rename = "catalog_entry/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CatalogEntryNetwork {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "proxy")]
    Proxy,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogEntryLimits {
    pub memory_bytes: u64,
    pub cpu_milli: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogEntry {
    pub schema: CatalogEntrySchema,
    pub entry_id: String,
    pub kind: CapsuleMetaKind,
    pub profile_id: String,
    pub label: String,
    pub image: String,
    pub window_width_px: u64,
    pub window_height_px: u64,
    pub display_width_px: u64,
    pub display_height_px: u64,
    pub display_only: bool,
    pub network: CatalogEntryNetwork,
    pub seccomp_identity: bool,
    pub nested_depth: u64,
    pub limits: CatalogEntryLimits,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HelloSchema {
    #[serde(rename = "hello/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HelloContractVersion {
    #[serde(rename = "v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HelloComponent {
    #[serde(rename = "core")]
    Core,
    #[serde(rename = "ui")]
    Ui,
    #[serde(rename = "daemon")]
    Daemon,
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "vision")]
    Vision,
    #[serde(rename = "wender")]
    Wender,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelloDependenciesItem {
    pub name: String,
    pub version: String,
    pub commit: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub schema: HelloSchema,
    pub contract_version: HelloContractVersion,
    pub component: HelloComponent,
    pub component_version: String,
    pub component_commit: String,
    pub dependencies: Vec<HelloDependenciesItem>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolCallCase0Schema {
    #[serde(rename = "mv_tool_call/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolCallCase0Op {
    #[serde(rename = "observe")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase0Args {
    pub surface_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase0 {
    pub schema: MvToolCallCase0Schema,
    pub request_id: String,
    pub op: MvToolCallCase0Op,
    pub args: MvToolCallCase0Args,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolCallCase1Op {
    #[serde(rename = "list")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MvToolCallCase1ArgsCursor {
    Case0(Box<String>),
    Case1(()),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase1Args {
    pub cursor: MvToolCallCase1ArgsCursor,
    pub limit: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase1 {
    pub schema: MvToolCallCase0Schema,
    pub request_id: String,
    pub op: MvToolCallCase1Op,
    pub args: MvToolCallCase1Args,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolCallCase2Op {
    #[serde(rename = "propose")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase2Args {
    pub proposal: ActionProposal,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase2 {
    pub schema: MvToolCallCase0Schema,
    pub request_id: String,
    pub op: MvToolCallCase2Op,
    pub args: MvToolCallCase2Args,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolCallCase3Op {
    #[serde(rename = "wait_verify")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase3Args {
    pub proposal_id: String,
    pub timeout_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolCallCase3 {
    pub schema: MvToolCallCase0Schema,
    pub request_id: String,
    pub op: MvToolCallCase3Op,
    pub args: MvToolCallCase3Args,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MvToolCall {
    Case0(Box<MvToolCallCase0>),
    Case1(Box<MvToolCallCase1>),
    Case2(Box<MvToolCallCase2>),
    Case3(Box<MvToolCallCase3>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase0Schema {
    #[serde(rename = "mv_tool_result/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase0Op {
    #[serde(rename = "observe")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase0Status {
    #[serde(rename = "ok")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultObservationSchema {
    #[serde(rename = "observation/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultFrameSchema {
    #[serde(rename = "frame_ref/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultFrameFormat {
    #[serde(rename = "rgb24")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultFrame {
    pub schema: MvToolResultFrameSchema,
    pub surface_id: String,
    pub generation: u64,
    pub tick: u64,
    pub ts_ns: u64,
    pub width: u64,
    pub height: u64,
    pub format: MvToolResultFrameFormat,
    pub ramws_path: String,
    pub sha256: String,
    pub capture_us: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultBbox {
    pub x: u64,
    pub y: u64,
    pub w: u64,
    pub h: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultObservationVisionElementsItem {
    pub bbox: MvToolResultBbox,
    pub role: String,
    pub name: String,
    pub confidence: serde_json::Number,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultObservationVision {
    pub summary: String,
    pub changed_regions: Vec<MvToolResultBbox>,
    pub elements: Vec<MvToolResultObservationVisionElementsItem>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultObservationGroundTruthSource {
    #[serde(rename = "holdings_lane")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultObservationGroundTruth {
    pub source: MvToolResultObservationGroundTruthSource,
    pub state_sha256: String,
    pub tick: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultObservation {
    pub schema: MvToolResultObservationSchema,
    pub frame_ref: MvToolResultFrame,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub vision: Optional<MvToolResultObservationVision>,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub ground_truth: Optional<MvToolResultObservationGroundTruth>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase0 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase0Op,
    pub status: MvToolResultCase0Status,
    pub observation: MvToolResultObservation,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase1Op {
    #[serde(rename = "list")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultSurfaceSchema {
    #[serde(rename = "surface/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultSurfaceKind {
    #[serde(rename = "desktop_capsule")]
    DesktopCapsule,
    #[serde(rename = "browser")]
    Browser,
    #[serde(rename = "game_capsule")]
    GameCapsule,
    #[serde(rename = "vm")]
    Vm,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultSurfaceGeometry {
    pub w: u64,
    pub h: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultSurfaceState {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "standby")]
    Standby,
    #[serde(rename = "ceded")]
    Ceded,
    #[serde(rename = "destroyed")]
    Destroyed,
    #[serde(rename = "lost")]
    Lost,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultSurfaceVisibility {
    #[serde(rename = "folded")]
    Folded,
    #[serde(rename = "unfolded")]
    Unfolded,
    #[serde(rename = "pinned")]
    Pinned,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultSurfaceControl {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "human")]
    Human,
    #[serde(rename = "shared")]
    Shared,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultSurface {
    pub schema: MvToolResultSurfaceSchema,
    pub surface_id: String,
    pub kind: MvToolResultSurfaceKind,
    pub display: String,
    pub geometry: MvToolResultSurfaceGeometry,
    pub state: MvToolResultSurfaceState,
    pub visibility: MvToolResultSurfaceVisibility,
    pub control: MvToolResultSurfaceControl,
    pub profile_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase1 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase1Op,
    pub status: MvToolResultCase0Status,
    pub surfaces: Vec<MvToolResultSurface>,
    pub next_cursor: MvToolCallCase1ArgsCursor,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase2Op {
    #[serde(rename = "propose")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase2Status {
    #[serde(rename = "admitted")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultVerdictAdmittedSchema {
    #[serde(rename = "action_verdict/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultVerdictAdmitted {
    pub schema: MvToolResultVerdictAdmittedSchema,
    pub proposal_id: String,
    pub decision: MvToolResultCase2Status,
    pub core_seq: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase2 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase2Op,
    pub status: MvToolResultCase2Status,
    pub verdict: MvToolResultVerdictAdmitted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase3Op {
    #[serde(rename = "observe")]
    Observe,
    #[serde(rename = "list")]
    List,
    #[serde(rename = "propose")]
    Propose,
    #[serde(rename = "wait_verify")]
    WaitVerify,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase3Status {
    #[serde(rename = "refused")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase3ReasonCode {
    #[serde(rename = "STALE_FRAME")]
    STALEFRAME,
    #[serde(rename = "SURFACE_NOT_AGENT_CONTROLLED")]
    SURFACENOTAGENTCONTROLLED,
    #[serde(rename = "LOCKED_BY_OTHER")]
    LOCKEDBYOTHER,
    #[serde(rename = "BUDGET_EXCEEDED")]
    BUDGETEXCEEDED,
    #[serde(rename = "OUT_OF_BOUNDS")]
    OUTOFBOUNDS,
    #[serde(rename = "POLICY")]
    POLICY,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase3 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase3Op,
    pub status: MvToolResultCase3Status,
    pub reason_code: MvToolResultCase3ReasonCode,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase4Op {
    #[serde(rename = "wait_verify")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase4Status {
    #[serde(rename = "pending")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase4 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase4Op,
    pub status: MvToolResultCase4Status,
    pub proposal_id: String,
    pub retry_after_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase5Status {
    #[serde(rename = "verified")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultReceiptVerifiedSchema {
    #[serde(rename = "action_receipt/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultReceiptVerifiedVerificationMethod {
    #[serde(rename = "pixel")]
    Pixel,
    #[serde(rename = "element")]
    Element,
    #[serde(rename = "state_sha256")]
    StateSha256,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultReceiptVerifiedVerification {
    pub method: MvToolResultReceiptVerifiedVerificationMethod,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultReceiptVerifiedError {
    #[serde(rename = "")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultReceiptVerified {
    pub schema: MvToolResultReceiptVerifiedSchema,
    pub proposal_id: String,
    pub executed_at_ns: u64,
    pub after_frame: MvToolResultFrame,
    pub verified: bool,
    pub verification: MvToolResultReceiptVerifiedVerification,
    pub error: MvToolResultReceiptVerifiedError,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase5 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase4Op,
    pub status: MvToolResultCase5Status,
    pub receipt: MvToolResultReceiptVerified,
    pub focus_verified: bool,
    pub input_mono_ns: u64,
    pub frame_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase6Status {
    #[serde(rename = "timeout")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase6 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase4Op,
    pub status: MvToolResultCase6Status,
    pub proposal_id: String,
    pub verified: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase7Status {
    #[serde(rename = "error")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MvToolResultCase7Code {
    #[serde(rename = "PROTOCOL")]
    PROTOCOL,
    #[serde(rename = "UNAVAILABLE")]
    UNAVAILABLE,
    #[serde(rename = "NOT_FOUND")]
    NOTFOUND,
    #[serde(rename = "VERIFICATION_FAILED")]
    VERIFICATIONFAILED,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MvToolResultCase7 {
    pub schema: MvToolResultCase0Schema,
    pub request_id: String,
    pub op: MvToolResultCase3Op,
    pub status: MvToolResultCase7Status,
    pub code: MvToolResultCase7Code,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MvToolResult {
    Case0(Box<MvToolResultCase0>),
    Case1(Box<MvToolResultCase1>),
    Case2(Box<MvToolResultCase2>),
    Case3(Box<MvToolResultCase3>),
    Case4(Box<MvToolResultCase4>),
    Case5(Box<MvToolResultCase5>),
    Case6(Box<MvToolResultCase6>),
    Case7(Box<MvToolResultCase7>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObservationSchema {
    #[serde(rename = "observation/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationVisionElementsItem {
    pub bbox: ActionProposalExpectationCase0Bbox,
    pub role: String,
    pub name: String,
    pub confidence: serde_json::Number,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationVision {
    pub summary: String,
    pub changed_regions: Vec<ActionProposalExpectationCase0Bbox>,
    pub elements: Vec<ObservationVisionElementsItem>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObservationGroundTruthSource {
    #[serde(rename = "holdings_lane")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationGroundTruth {
    pub source: ObservationGroundTruthSource,
    pub state_sha256: String,
    pub tick: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub schema: ObservationSchema,
    pub frame_ref: FrameRef,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub vision: Optional<ObservationVision>,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub ground_truth: Optional<ObservationGroundTruth>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase0Schema {
    #[serde(rename = "record_event/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase0Event {
    #[serde(rename = "started")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase0Mode {
    #[serde(rename = "ram")]
    Ram,
    #[serde(rename = "disk")]
    Disk,
    #[serde(rename = "screenshot")]
    Screenshot,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordEventCase0 {
    pub schema: RecordEventCase0Schema,
    pub request_id: String,
    pub surface_id: String,
    pub recording_id: String,
    pub event: RecordEventCase0Event,
    pub mono_ns: u64,
    pub mode: RecordEventCase0Mode,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase1Event {
    #[serde(rename = "stopped")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordEventCase1 {
    pub schema: RecordEventCase0Schema,
    pub request_id: String,
    pub surface_id: String,
    pub recording_id: String,
    pub event: RecordEventCase1Event,
    pub mono_ns: u64,
    pub frame_count: u64,
    pub byte_count: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase2Event {
    #[serde(rename = "frame_captured")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordEventCase2 {
    pub schema: RecordEventCase0Schema,
    pub request_id: String,
    pub surface_id: String,
    pub recording_id: String,
    pub event: RecordEventCase2Event,
    pub mono_ns: u64,
    pub ram_path: String,
    pub sha256: String,
    pub byte_count: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase3Event {
    #[serde(rename = "exported")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordEventCase3 {
    pub schema: RecordEventCase0Schema,
    pub request_id: String,
    pub surface_id: String,
    pub recording_id: String,
    pub event: RecordEventCase3Event,
    pub mono_ns: u64,
    pub destination_capability_id: String,
    pub destination_path: String,
    pub sha256: String,
    pub byte_count: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase4Event {
    #[serde(rename = "dropped")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventCase4Policy {
    #[serde(rename = "ram_ring_oldest")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordEventCase4 {
    pub schema: RecordEventCase0Schema,
    pub request_id: String,
    pub surface_id: String,
    pub recording_id: String,
    pub event: RecordEventCase4Event,
    pub mono_ns: u64,
    pub dropped_frames: u64,
    pub policy: RecordEventCase4Policy,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordEventRefusal {
    #[serde(rename = "STALE_FRAME")]
    STALEFRAME,
    #[serde(rename = "SURFACE_NOT_AGENT_CONTROLLED")]
    SURFACENOTAGENTCONTROLLED,
    #[serde(rename = "LOCKED_BY_OTHER")]
    LOCKEDBYOTHER,
    #[serde(rename = "BUDGET_EXCEEDED")]
    BUDGETEXCEEDED,
    #[serde(rename = "OUT_OF_BOUNDS")]
    OUTOFBOUNDS,
    #[serde(rename = "POLICY")]
    POLICY,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordEventCase5 {
    pub schema: RecordEventCase0Schema,
    pub request_id: String,
    pub surface_id: String,
    pub recording_id: String,
    pub event: ActionVerdictCase0Decision,
    pub mono_ns: u64,
    pub reason_code: RecordEventRefusal,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RecordEvent {
    Case0(Box<RecordEventCase0>),
    Case1(Box<RecordEventCase1>),
    Case2(Box<RecordEventCase2>),
    Case3(Box<RecordEventCase3>),
    Case4(Box<RecordEventCase4>),
    Case5(Box<RecordEventCase5>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordRequestCase0Schema {
    #[serde(rename = "record_request/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordRequestCase0Op {
    #[serde(rename = "ram_start")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase0Params {
    pub surface_id: String,
    pub recording_id: String,
    pub ring_bytes: u64,
    pub max_fps: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase0 {
    pub schema: RecordRequestCase0Schema,
    pub request_id: String,
    pub op: RecordRequestCase0Op,
    pub params: RecordRequestCase0Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordRequestCase1Op {
    #[serde(rename = "ram_stop")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase1Params {
    pub surface_id: String,
    pub recording_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase1 {
    pub schema: RecordRequestCase0Schema,
    pub request_id: String,
    pub op: RecordRequestCase1Op,
    pub params: RecordRequestCase1Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordRequestCase2Op {
    #[serde(rename = "disk_start")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase2Params {
    pub surface_id: String,
    pub recording_id: String,
    pub destination_capability_id: String,
    pub destination_path: String,
    pub max_fps: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase2 {
    pub schema: RecordRequestCase0Schema,
    pub request_id: String,
    pub op: RecordRequestCase2Op,
    pub params: RecordRequestCase2Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordRequestCase3Op {
    #[serde(rename = "disk_stop")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase3 {
    pub schema: RecordRequestCase0Schema,
    pub request_id: String,
    pub op: RecordRequestCase3Op,
    pub params: RecordRequestCase1Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordRequestCase4Op {
    #[serde(rename = "screenshot")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase4Params {
    pub surface_id: String,
    pub capture_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRequestCase4 {
    pub schema: RecordRequestCase0Schema,
    pub request_id: String,
    pub op: RecordRequestCase4Op,
    pub params: RecordRequestCase4Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RecordRequest {
    Case0(Box<RecordRequestCase0>),
    Case1(Box<RecordRequestCase1>),
    Case2(Box<RecordRequestCase2>),
    Case3(Box<RecordRequestCase3>),
    Case4(Box<RecordRequestCase4>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionRecordSchema {
    #[serde(rename = "session_record/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionRecordKind {
    #[serde(rename = "received")]
    Received,
    #[serde(rename = "admitted")]
    Admitted,
    #[serde(rename = "refused")]
    Refused,
    #[serde(rename = "executed")]
    Executed,
    #[serde(rename = "verified")]
    Verified,
    #[serde(rename = "surface_changed")]
    SurfaceChanged,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRecord {
    pub schema: SessionRecordSchema,
    pub core_seq: u64,
    pub kind: SessionRecordKind,
    pub msg_id: String,
    pub prev_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettingsSchema {
    #[serde(rename = "settings/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettingsTheme {
    #[serde(rename = "metaviewer-light")]
    MetaviewerLight,
    #[serde(rename = "metaviewer-dark")]
    MetaviewerDark,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsProvidersItem {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub model: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsRecordingDestinationCase0 {
    pub capability_id: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingsRecordingDestination {
    Case0(Box<SettingsRecordingDestinationCase0>),
    Case1(()),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsLimits {
    pub memory_bytes: u64,
    pub max_fps: u64,
    pub ring_bytes: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub schema: SettingsSchema,
    pub theme: SettingsTheme,
    pub providers: Vec<SettingsProvidersItem>,
    pub recording_destination: SettingsRecordingDestination,
    pub limits: SettingsLimits,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceSchema {
    #[serde(rename = "surface/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceKind {
    #[serde(rename = "desktop_capsule")]
    DesktopCapsule,
    #[serde(rename = "browser")]
    Browser,
    #[serde(rename = "game_capsule")]
    GameCapsule,
    #[serde(rename = "vm")]
    Vm,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceGeometry {
    pub w: u64,
    pub h: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceState {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "standby")]
    Standby,
    #[serde(rename = "ceded")]
    Ceded,
    #[serde(rename = "destroyed")]
    Destroyed,
    #[serde(rename = "lost")]
    Lost,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceVisibility {
    #[serde(rename = "folded")]
    Folded,
    #[serde(rename = "unfolded")]
    Unfolded,
    #[serde(rename = "pinned")]
    Pinned,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceControl {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "human")]
    Human,
    #[serde(rename = "shared")]
    Shared,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Surface {
    pub schema: SurfaceSchema,
    pub surface_id: String,
    pub kind: SurfaceKind,
    pub display: String,
    pub geometry: SurfaceGeometry,
    pub state: SurfaceState,
    pub visibility: SurfaceVisibility,
    pub control: SurfaceControl,
    pub profile_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceEventCase0Schema {
    #[serde(rename = "surface_event/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceEventCase0Event {
    #[serde(rename = "created")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase0Data {
    pub surface: Surface,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase0 {
    pub schema: SurfaceEventCase0Schema,
    pub event: SurfaceEventCase0Event,
    pub data: SurfaceEventCase0Data,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceEventCase1Event {
    #[serde(rename = "state_changed")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase1 {
    pub schema: SurfaceEventCase0Schema,
    pub event: SurfaceEventCase1Event,
    pub data: SurfaceEventCase0Data,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceEventCase2Event {
    #[serde(rename = "frame_ready")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase2Data {
    pub frame_ref: FrameRef,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase2 {
    pub schema: SurfaceEventCase0Schema,
    pub event: SurfaceEventCase2Event,
    pub data: SurfaceEventCase2Data,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceEventCase3Event {
    #[serde(rename = "input_applied")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase3Data {
    pub surface_id: String,
    pub proposal_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase3 {
    pub schema: SurfaceEventCase0Schema,
    pub event: SurfaceEventCase3Event,
    pub data: SurfaceEventCase3Data,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceEventCase4Event {
    #[serde(rename = "error")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase4Data {
    pub surface_id: String,
    pub code: String,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventCase4 {
    pub schema: SurfaceEventCase0Schema,
    pub event: SurfaceEventCase4Event,
    pub data: SurfaceEventCase4Data,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SurfaceEvent {
    Case0(Box<SurfaceEventCase0>),
    Case1(Box<SurfaceEventCase1>),
    Case2(Box<SurfaceEventCase2>),
    Case3(Box<SurfaceEventCase3>),
    Case4(Box<SurfaceEventCase4>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase0Schema {
    #[serde(rename = "surface_request/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase0Op {
    #[serde(rename = "create")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase0Params {
    pub kind: SurfaceKind,
    pub geometry: SurfaceGeometry,
    pub profile_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase0 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase0Op,
    pub params: SurfaceRequestCase0Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCreateNestedParams {
    pub kind: SurfaceKind,
    pub geometry: SurfaceGeometry,
    pub profile_id: String,
    pub nested_depth: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCreateNested {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase0Op,
    pub params: SurfaceRequestCreateNestedParams,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase1Params {}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase1 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: MvToolCallCase1Op,
    pub params: SurfaceRequestCase1Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase2Op {
    #[serde(rename = "destroy")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase2Params {
    pub surface_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase2 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase2Op,
    pub params: SurfaceRequestCase2Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase3Op {
    #[serde(rename = "frame_subscribe")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase3 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase3Op,
    pub params: SurfaceRequestCase2Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase4Op {
    #[serde(rename = "frame_unsubscribe")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase4 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase4Op,
    pub params: SurfaceRequestCase2Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase5Op {
    #[serde(rename = "input")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestInputOrigin {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "human")]
    Human,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase5Params {
    pub surface_id: String,
    pub proposal_id: String,
    #[serde(
        default = "Optional::missing",
        skip_serializing_if = "Optional::is_missing"
    )]
    pub origin: Optional<SurfaceRequestInputOrigin>,
    pub action: ActionProposalAction,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase5 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase5Op,
    pub params: SurfaceRequestCase5Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase6Op {
    #[serde(rename = "record_start")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase6Params {
    pub surface_id: String,
    pub recording_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase6 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase6Op,
    pub params: SurfaceRequestCase6Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase7Op {
    #[serde(rename = "record_stop")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase7 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase7Op,
    pub params: SurfaceRequestCase6Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase8Op {
    #[serde(rename = "take_control")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase8Params {
    pub surface_id: String,
    pub owner: SurfaceControl,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase8 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase8Op,
    pub params: SurfaceRequestCase8Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SurfaceRequestCase9Op {
    #[serde(rename = "release_control")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequestCase9 {
    pub schema: SurfaceRequestCase0Schema,
    pub op: SurfaceRequestCase9Op,
    pub params: SurfaceRequestCase2Params,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SurfaceRequest {
    Case0(Box<SurfaceRequestCase0>),
    CreateNested(Box<SurfaceRequestCreateNested>),
    Case1(Box<SurfaceRequestCase1>),
    Case2(Box<SurfaceRequestCase2>),
    Case3(Box<SurfaceRequestCase3>),
    Case4(Box<SurfaceRequestCase4>),
    Case5(Box<SurfaceRequestCase5>),
    Case6(Box<SurfaceRequestCase6>),
    Case7(Box<SurfaceRequestCase7>),
    Case8(Box<SurfaceRequestCase8>),
    Case9(Box<SurfaceRequestCase9>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase0Op {
    #[serde(rename = "spawn")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase0Params {
    pub cols: u64,
    pub provider_id: String,
    pub rows: u64,
    pub surface_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase0Schema {
    #[serde(rename = "terminal_session/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase0 {
    pub op: TerminalSessionCase0Op,
    pub params: TerminalSessionCase0Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase1Params {
    pub cols: u64,
    pub provider_id: String,
    pub rows: u64,
    pub session_id: String,
    pub surface_id: String,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase1 {
    pub op: RecordEventCase0Event,
    pub params: TerminalSessionCase1Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase2Op {
    #[serde(rename = "resize")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase2Params {
    pub cols: u64,
    pub rows: u64,
    pub session_id: String,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase2 {
    pub op: TerminalSessionCase2Op,
    pub params: TerminalSessionCase2Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase3Op {
    #[serde(rename = "data")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase3Params {
    pub b64: String,
    pub byte_count: u64,
    pub gap: bool,
    pub seq: u64,
    pub session_id: String,
    pub terminal_generation: u64,
    pub truncated: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase3 {
    pub op: TerminalSessionCase3Op,
    pub params: TerminalSessionCase3Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase4Op {
    #[serde(rename = "write")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase4Params {
    pub b64: String,
    pub byte_count: u64,
    pub input_seq: u64,
    pub session_id: String,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase4 {
    pub op: TerminalSessionCase4Op,
    pub params: TerminalSessionCase4Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase5Op {
    #[serde(rename = "ack")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase5Params {
    pub ack_bytes: u64,
    pub ack_seq: u64,
    pub session_id: String,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase5 {
    pub op: TerminalSessionCase5Op,
    pub params: TerminalSessionCase5Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase6Op {
    #[serde(rename = "resync")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase6Params {
    pub from_seq: u64,
    pub session_id: String,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase6 {
    pub op: TerminalSessionCase6Op,
    pub params: TerminalSessionCase6Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase7Op {
    #[serde(rename = "attach")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase7 {
    pub op: TerminalSessionCase7Op,
    pub params: TerminalSessionCase5Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase8Op {
    #[serde(rename = "close")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase8Params {
    pub session_id: String,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase8 {
    pub op: TerminalSessionCase8Op,
    pub params: TerminalSessionCase8Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase9Op {
    #[serde(rename = "exit")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TerminalSessionNullableId {
    Case0(Box<String>),
    Case1(()),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase9Params {
    pub exit_code: u64,
    pub session_id: String,
    pub signal: TerminalSessionNullableId,
    pub terminal_generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase9 {
    pub op: TerminalSessionCase9Op,
    pub params: TerminalSessionCase9Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalSessionCase10ParamsCode {
    #[serde(rename = "UNKNOWN_PROVIDER")]
    UNKNOWNPROVIDER,
    #[serde(rename = "UNKNOWN_SESSION")]
    UNKNOWNSESSION,
    #[serde(rename = "STALE_GENERATION")]
    STALEGENERATION,
    #[serde(rename = "READ_ONLY")]
    READONLY,
    #[serde(rename = "RESYNC_UNAVAILABLE")]
    RESYNCUNAVAILABLE,
    #[serde(rename = "BACKPRESSURE")]
    BACKPRESSURE,
    #[serde(rename = "POLICY")]
    POLICY,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase10Params {
    pub code: TerminalSessionCase10ParamsCode,
    pub detail: String,
    pub session_id: TerminalSessionNullableId,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSessionCase10 {
    pub op: SurfaceEventCase4Event,
    pub params: TerminalSessionCase10Params,
    pub request_id: String,
    pub schema: TerminalSessionCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TerminalSession {
    Case0(Box<TerminalSessionCase0>),
    Case1(Box<TerminalSessionCase1>),
    Case2(Box<TerminalSessionCase2>),
    Case3(Box<TerminalSessionCase3>),
    Case4(Box<TerminalSessionCase4>),
    Case5(Box<TerminalSessionCase5>),
    Case6(Box<TerminalSessionCase6>),
    Case7(Box<TerminalSessionCase7>),
    Case8(Box<TerminalSessionCase8>),
    Case9(Box<TerminalSessionCase9>),
    Case10(Box<TerminalSessionCase10>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase0Op {
    #[serde(rename = "fold")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase0Params {
    pub slot_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase0Schema {
    #[serde(rename = "ui_intent/v0.2")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase0 {
    pub op: UiIntentCase0Op,
    pub params: UiIntentCase0Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase1Op {
    #[serde(rename = "unfold")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase1 {
    pub op: UiIntentCase1Op,
    pub params: UiIntentCase0Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase2Op {
    #[serde(rename = "hide")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase2 {
    pub op: UiIntentCase2Op,
    pub params: UiIntentCase0Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase3Op {
    #[serde(rename = "show")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase3 {
    pub op: UiIntentCase3Op,
    pub params: UiIntentCase0Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase4Op {
    #[serde(rename = "pin")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase4Params {
    pub pinned: bool,
    pub slot_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase4 {
    pub op: UiIntentCase4Op,
    pub params: UiIntentCase4Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase5Op {
    #[serde(rename = "move")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase5Params {
    pub group_id: String,
    pub index: u64,
    pub slot_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase5 {
    pub op: UiIntentCase5Op,
    pub params: UiIntentCase5Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase6Op {
    #[serde(rename = "tab")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase6 {
    pub op: UiIntentCase6Op,
    pub params: UiIntentCase5Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase7Op {
    #[serde(rename = "float")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase7Params {
    pub height_px: u64,
    pub slot_id: String,
    pub width_px: u64,
    pub x_px: u64,
    pub y_px: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase7 {
    pub op: UiIntentCase7Op,
    pub params: UiIntentCase7Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase8Op {
    #[serde(rename = "layout_save")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase8Params {
    pub layout_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase8 {
    pub op: UiIntentCase8Op,
    pub params: UiIntentCase8Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiIntentCase9Op {
    #[serde(rename = "layout_load")]
    Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiIntentCase9 {
    pub op: UiIntentCase9Op,
    pub params: UiIntentCase8Params,
    pub request_id: String,
    pub schema: UiIntentCase0Schema,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiControlOp {
    #[serde(rename = "take_control")]
    TakeControl,
    #[serde(rename = "release_control")]
    ReleaseControl,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiControlParams {
    pub surface_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiControl {
    pub schema: UiIntentCase0Schema,
    pub request_id: String,
    pub op: UiControlOp,
    pub params: UiControlParams,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UiIntent {
    Control(Box<UiControl>),
    Case0(Box<UiIntentCase0>),
    Case1(Box<UiIntentCase1>),
    Case2(Box<UiIntentCase2>),
    Case3(Box<UiIntentCase3>),
    Case4(Box<UiIntentCase4>),
    Case5(Box<UiIntentCase5>),
    Case6(Box<UiIntentCase6>),
    Case7(Box<UiIntentCase7>),
    Case8(Box<UiIntentCase8>),
    Case9(Box<UiIntentCase9>),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Command {
    ActionProposal(Box<ActionProposal>),
    ActionReceipt(Box<ActionReceipt>),
    ActionVerdict(Box<ActionVerdict>),
    CapsuleMeta(Box<CapsuleMeta>),
    CatalogEntry(Box<CatalogEntry>),
    FrameRef(Box<FrameRef>),
    Hello(Box<Hello>),
    MvToolCall(Box<MvToolCall>),
    MvToolResult(Box<MvToolResult>),
    Observation(Box<Observation>),
    RecordEvent(Box<RecordEvent>),
    RecordRequest(Box<RecordRequest>),
    SessionRecord(Box<SessionRecord>),
    Settings(Box<Settings>),
    Surface(Box<Surface>),
    SurfaceEvent(Box<SurfaceEvent>),
    SurfaceRequest(Box<SurfaceRequest>),
    TerminalSession(Box<TerminalSession>),
    UiIntent(Box<UiIntent>),
}

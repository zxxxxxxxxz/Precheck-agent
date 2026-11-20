/** Presentation only: retain all source diagnostics and business decision inputs. */
const backgroundDiagnostics = new Set([
  'cloud_field_source_assembly_uncertain', 'cloud_field_source_assembly_elsewhere', 'cloud_field_coverage_incomplete',
  'cloud_field_model_coverage_incomplete', 'source_text_conflict', 'source_word_parent_unverified',
  'text_layer_trust_not_established', 'native_text_visibility_or_geometry_unverified',
  'non_text_visual_content_unverified', 'non_text_visible_ink_unclassified',
  'image_semantics_or_handwriting_unverified', 'image_evidence_content_unverified',
  'visible_ink_is_signature_candidate_only',
]);
export const visibleProcessingGap = (code:string) => !backgroundDiagnostics.has(code);
export const visibleProcessingGaps = (codes:readonly string[]) => codes.filter(visibleProcessingGap);

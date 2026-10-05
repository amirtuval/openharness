{{/*
The chart's names and labels, in one place.

The release and the chart are both called openharness, so `openharness.fullname` is the plain
name in the normal case — which is what Terraform's `helm_release openharness` expects the
resources to be called.
*/}}

{{/* The chart name, or an override. */}}
{{- define "openharness.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The resource name: the release name when it already contains the chart name (it does:
both are `openharness`), otherwise `<release>-<chart>`. `nameOverride`/`fullnameOverride`
are honoured for a release that has to share a namespace.
*/}}
{{- define "openharness.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Labels on every object: what it is, which release, which chart, who manages it. */}}
{{- define "openharness.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "openharness.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The labels a selector matches on — the smallest stable set. They are on the pods too, so the
Service, the Deployment, the HPA and the PodDisruptionBudget all agree on what they own, and
none of them changes when the image does.
*/}}
{{- define "openharness.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openharness.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The Kubernetes ServiceAccount the pod runs as (the Workload Identity identity). */}}
{{- define "openharness.serviceAccountName" -}}
{{- default (include "openharness.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}

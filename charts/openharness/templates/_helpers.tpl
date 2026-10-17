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

{{/*
Refuse a rendering that would run LocalScheduler on more than one pod.

`SCHEDULER=local` — the server's default, not this chart's — owns every partition in the
process and writes unfenced, so it is safe only where a single pod runs: a second pod, at boot
or during a rolling update, recovers and re-runs turns the first pod still owns, and an
interrupt handled on the wrong pod starts a second brain for the session. `values.yaml` defaults
`env.SCHEDULER` to `postgres` so no environment can forget it; this helper is for the values
file that sets it back: it fails the render when the Deployment can have more than one pod.
*/}}
{{- define "openharness.validateScheduler" -}}
{{- $env := .Values.env | default dict -}}
{{- $scheduler := get $env "SCHEDULER" | toString -}}
{{- $replicas := .Values.replicaCount | int -}}
{{- $hpaMax := 0 -}}
{{- if .Values.autoscaling.enabled -}}
{{- $hpaMax = .Values.autoscaling.maxReplicas | int -}}
{{- end -}}
{{- if and (eq $scheduler "local") (or (gt $replicas 1) (gt $hpaMax 1)) -}}
{{- fail (printf "SCHEDULER=local is single-instance only and cannot run with more than one pod (replicaCount=%d, autoscaling.enabled=%t, autoscaling.maxReplicas=%d). Set SCHEDULER=postgres — the chart default — or run a single replica with autoscaling disabled or maxReplicas=1." $replicas .Values.autoscaling.enabled $hpaMax) -}}
{{- end -}}
{{- end -}}

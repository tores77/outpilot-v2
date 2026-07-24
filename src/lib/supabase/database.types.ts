export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      allowed_users: {
        Row: {
          display_name: string | null
          email: string
          role: string
          tenant_id: string
        }
        Insert: {
          display_name?: string | null
          email: string
          role?: string
          tenant_id: string
        }
        Update: {
          display_name?: string | null
          email?: string
          role?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "allowed_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_costs: {
        Row: {
          cost_usd: number | null
          created_at: string
          id: string
          latency_ms: number | null
          model: string
          task: string
          tenant_id: string
          tokens_in: number
          tokens_out: number
        }
        Insert: {
          cost_usd?: number | null
          created_at?: string
          id?: string
          latency_ms?: number | null
          model: string
          task: string
          tenant_id: string
          tokens_in: number
          tokens_out: number
        }
        Update: {
          cost_usd?: number | null
          created_at?: string
          id?: string
          latency_ms?: number | null
          model?: string
          task?: string
          tenant_id?: string
          tokens_in?: number
          tokens_out?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_costs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          actor: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          kind: string
          payload: Json
          tenant_id: string
        }
        Insert: {
          actor?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind: string
          payload?: Json
          tenant_id: string
        }
        Update: {
          actor?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind?: string
          payload?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          city: string | null
          company: string | null
          country: string | null
          created_at: string
          custom_fields: Json
          email: string
          estado: Database["public"]["Enums"]["lead_estado"]
          first_name: string | null
          icp_score: number | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          phone: string | null
          sector: string | null
          source: Database["public"]["Enums"]["lead_source"]
          tenant_id: string
          title: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          custom_fields?: Json
          email: string
          estado?: Database["public"]["Enums"]["lead_estado"]
          first_name?: string | null
          icp_score?: number | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          phone?: string | null
          sector?: string | null
          source: Database["public"]["Enums"]["lead_source"]
          tenant_id: string
          title?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          custom_fields?: Json
          email?: string
          estado?: Database["public"]["Enums"]["lead_estado"]
          first_name?: string | null
          icp_score?: number | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          phone?: string | null
          sector?: string | null
          source?: Database["public"]["Enums"]["lead_source"]
          tenant_id?: string
          title?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          id: string
          name: string
          settings: Json
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          settings?: Json
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          settings?: Json
          slug?: string
        }
        Relationships: []
      }
      twenty_sync: {
        Row: {
          error: string | null
          last_synced_at: string | null
          lead_id: string
          sync_status: string
          tenant_id: string
          twenty_company_id: string | null
          twenty_opportunity_id: string | null
          twenty_person_id: string | null
        }
        Insert: {
          error?: string | null
          last_synced_at?: string | null
          lead_id: string
          sync_status?: string
          tenant_id: string
          twenty_company_id?: string | null
          twenty_opportunity_id?: string | null
          twenty_person_id?: string | null
        }
        Update: {
          error?: string | null
          last_synced_at?: string | null
          lead_id?: string
          sync_status?: string
          tenant_id?: string
          twenty_company_id?: string | null
          twenty_opportunity_id?: string | null
          twenty_person_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "twenty_sync_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "twenty_sync_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_user_tenant_id: { Args: never; Returns: string }
    }
    Enums: {
      lead_estado:
        | "NUEVO"
        | "EN_SECUENCIA"
        | "RESPONDIO"
        | "REUNION_AGENDADA"
        | "REUNION_REALIZADA"
        | "NO_SHOW"
        | "PROPUESTA_ENVIADA"
        | "NEGOCIACION"
        | "CLIENTE"
        | "PERDIDO"
        | "NURTURING"
        | "EN_RADAR"
      lead_source:
        | "vibe_prospecting"
        | "csv_import"
        | "manual"
        | "studio_inbound"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      lead_estado: [
        "NUEVO",
        "EN_SECUENCIA",
        "RESPONDIO",
        "REUNION_AGENDADA",
        "REUNION_REALIZADA",
        "NO_SHOW",
        "PROPUESTA_ENVIADA",
        "NEGOCIACION",
        "CLIENTE",
        "PERDIDO",
        "NURTURING",
        "EN_RADAR",
      ],
      lead_source: [
        "vibe_prospecting",
        "csv_import",
        "manual",
        "studio_inbound",
      ],
    },
  },
} as const

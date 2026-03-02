use super::{PluginType, PluginAuthority, MAX_ATTRIBUTES};

/// Maximum key length for an attribute
pub const MAX_ATTRIBUTE_KEY_LEN: usize = 32;
/// Maximum value length for an attribute
pub const MAX_ATTRIBUTE_VALUE_LEN: usize = 64;

/// A single attribute key-value pair (fixed size for no_std)
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct Attribute {
    /// The key of the attribute (fixed size)
    pub key: [u8; MAX_ATTRIBUTE_KEY_LEN],
    /// Actual length of the key
    pub key_len: u8,
    /// The value of the attribute (fixed size)
    pub value: [u8; MAX_ATTRIBUTE_VALUE_LEN],
    /// Actual length of the value
    pub value_len: u8,
    /// Is this attribute slot active?
    pub is_active: bool,
    /// Padding for alignment
    pub _padding: [u8; 1],
}

impl Attribute {
    /// Size of a single attribute in bytes
    pub const LEN: usize = MAX_ATTRIBUTE_KEY_LEN + 1 + MAX_ATTRIBUTE_VALUE_LEN + 1 + 1 + 1;

    /// Create a new attribute
    pub fn new(key: &[u8], value: &[u8]) -> Self {
        let mut attr = Self {
            key: [0u8; MAX_ATTRIBUTE_KEY_LEN],
            key_len: 0,
            value: [0u8; MAX_ATTRIBUTE_VALUE_LEN],
            value_len: 0,
            is_active: true,
            _padding: [0; 1],
        };

        // Copy key
        let key_len = key.len().min(MAX_ATTRIBUTE_KEY_LEN);
        attr.key[..key_len].copy_from_slice(&key[..key_len]);
        attr.key_len = key_len as u8;

        // Copy value
        let value_len = value.len().min(MAX_ATTRIBUTE_VALUE_LEN);
        attr.value[..value_len].copy_from_slice(&value[..value_len]);
        attr.value_len = value_len as u8;

        attr
    }

    /// Get the key as a slice
    pub fn get_key(&self) -> &[u8] {
        let len = (self.key_len as usize).min(MAX_ATTRIBUTE_KEY_LEN);
        &self.key[..len]
    }

    /// Get the value as a slice
    pub fn get_value(&self) -> &[u8] {
        let len = (self.value_len as usize).min(MAX_ATTRIBUTE_VALUE_LEN);
        &self.value[..len]
    }

    /// Clear this attribute slot
    pub fn clear(&mut self) {
        self.is_active = false;
        self.key_len = 0;
        self.value_len = 0;
    }
}

/// The Attributes plugin for storing key-value pairs on-chain (fixed size for no_std)
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct Attributes {
    /// Plugin type discriminator
    pub plugin_type: PluginType,
    /// Authority who can update attributes
    pub authority: PluginAuthority,
    /// Reserved space for authority pubkey if Address type
    pub authority_key: [u8; 32],
    /// Number of active attributes
    pub attribute_count: u8,
    /// Padding for alignment
    pub _padding: [u8; 3],
    /// Fixed-size array of attributes
    pub attributes: [Attribute; MAX_ATTRIBUTES],
}

impl Attributes {
    /// Total size of the Attributes plugin in bytes
    pub const LEN: usize = 1 // plugin_type
        + 1 // authority discriminator
        + 32 // authority key
        + 1 // attribute_count
        + 3 // padding
        + (Attribute::LEN * MAX_ATTRIBUTES); // attributes array

    /// Create a new Attributes plugin
    pub fn new(authority: PluginAuthority) -> Self {
        let mut authority_key = [0u8; 32];
        if let PluginAuthority::Address(pubkey) = authority {
            authority_key.copy_from_slice(&pubkey);
        }

        Self {
            plugin_type: PluginType::Attributes,
            authority,
            authority_key,
            attribute_count: 0,
            _padding: [0; 3],
            attributes: [Attribute {
                key: [0; MAX_ATTRIBUTE_KEY_LEN],
                key_len: 0,
                value: [0; MAX_ATTRIBUTE_VALUE_LEN],
                value_len: 0,
                is_active: false,
                _padding: [0; 1],
            }; MAX_ATTRIBUTES],
        }
    }

    /// Add or update an attribute
    pub fn set_attribute(&mut self, key: &[u8], value: &[u8]) -> bool {
        // First check if attribute exists and update it
        for attr in self.attributes.iter_mut() {
            if attr.is_active && attr.get_key() == key {
                // Update existing attribute
                let value_len = value.len().min(MAX_ATTRIBUTE_VALUE_LEN);
                attr.value[..value_len].copy_from_slice(&value[..value_len]);
                attr.value_len = value_len as u8;
                return true;
            }
        }

        // Find empty slot for new attribute
        for attr in self.attributes.iter_mut() {
            if !attr.is_active {
                *attr = Attribute::new(key, value);
                self.attribute_count = self.attribute_count.saturating_add(1);
                return true;
            }
        }

        // No slots available
        false
    }

    /// Remove an attribute by key
    pub fn remove_attribute(&mut self, key: &[u8]) -> bool {
        for attr in self.attributes.iter_mut() {
            if attr.is_active && attr.get_key() == key {
                attr.clear();
                self.attribute_count = self.attribute_count.saturating_sub(1);
                return true;
            }
        }
        false
    }

    /// Get an attribute by key
    pub fn get_attribute(&self, key: &[u8]) -> Option<&Attribute> {
        self.attributes.iter()
            .find(|attr| attr.is_active && attr.get_key() == key)
    }

    /// Load Attributes plugin from account data
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    /// Load mutable Attributes plugin from account data
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }
}